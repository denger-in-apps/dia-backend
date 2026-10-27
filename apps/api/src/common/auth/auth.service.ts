import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';
import { Pool, PoolClient } from 'pg';
import { EncryptionService } from '../crypto/encryption.service';
import { DATABASE_POOL } from '../../database/database.module';
import { AuthProfile, AuthSession, AuthenticatedUser, UserRole } from './auth.types';
import { StudentIdentity } from './oidc-sso.strategy';

interface RefreshRow {
  id: string;
  role: UserRole;
  id_pengguna: string;
  token_family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

const ACCESS_TOKEN_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly encryption: EncryptionService,
  ) {}

  async loginStaff(
    role: Extract<UserRole, 'PSIKOLOG' | 'DOSEN_ADMIN'>,
    email: string,
    password: string,
    otp: string | undefined,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    const isPsychologist = role === 'PSIKOLOG';
    const query = isPsychologist
      ? `SELECT id_psikolog::text AS id, nama, email::text AS email, password_hash,
                mfa_secret_enc, (status_akun = 'AKTIF') AS aktif
         FROM psikolog WHERE email = $1`
      : `SELECT id_dosen::text AS id, nama, email::text AS email, password_hash,
                mfa_secret_enc, aktif
         FROM dosen_admin WHERE email = $1`;
    const result = await this.pool.query(query, [email.trim().toLowerCase()]);
    const account = result.rows[0];
    if (!account?.password_hash) throw new UnauthorizedException('Email atau password salah');

    let passwordIsValid = false;
    try {
      passwordIsValid = await argon2.verify(account.password_hash, password);
    } catch {
      passwordIsValid = false;
    }
    if (!passwordIsValid) throw new UnauthorizedException('Email atau password salah');
    if (!account.aktif) throw new ForbiddenException('Akun staf belum aktif');

    if (account.mfa_secret_enc) {
      if (!otp || !this.verifyTotp(account.mfa_secret_enc, role, account.id, otp)) {
        throw new UnauthorizedException('Email atau password salah');
      }
    } else if (otp) {
      throw new UnauthorizedException('Email atau password salah');
    }

    return this.issueSession({ id: account.id, role }, ip, userAgent);
  }

  async loginStudent(
    identity: StudentIdentity,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    let result;
    try {
      result = await this.pool.query(
        `INSERT INTO mahasiswa (sso_subject, nim, email, nama)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (nim) DO UPDATE
           SET sso_subject = EXCLUDED.sso_subject,
               email = EXCLUDED.email,
               nama = EXCLUDED.nama,
               updated_at = now()
         WHERE mahasiswa.deleted_at IS NULL
           AND (mahasiswa.sso_subject IS NULL OR mahasiswa.sso_subject = EXCLUDED.sso_subject)
         RETURNING id_mahasiswa::text AS id, status_aktif, deleted_at`,
        [identity.subject, identity.nim, identity.email, identity.name],
      );
    } catch {
      throw new UnauthorizedException('Akun SSO mahasiswa tidak dapat diverifikasi');
    }

    const student = result.rows[0];
    if (!student) throw new UnauthorizedException('Akun SSO mahasiswa tidak dapat diverifikasi');
    if (student.deleted_at || !student.status_aktif) {
      throw new ForbiddenException('AKUN_TIDAK_AKTIF');
    }

    return this.issueSession({ id: student.id, role: 'MAHASISWA' }, ip, userAgent);
  }

  async refresh(
    rawToken: string,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    const tokenHash = this.hashToken(rawToken);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const result = await client.query<RefreshRow>(
        `SELECT id::text, role, id_pengguna::text, token_family_id::text,
                expires_at, revoked_at, replaced_by::text
         FROM refresh_token WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const previous = result.rows[0];
      if (!previous) throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');

      if (previous.revoked_at) {
        if (previous.replaced_by) {
          await client.query(
            `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
             WHERE token_family_id = $1`,
            [previous.token_family_id],
          );
          await client.query('COMMIT');
          transactionOpen = false;
        }
        throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
      }
      if (new Date(previous.expires_at).getTime() <= Date.now()) {
        throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
      }
      if (!(await this.isAccountActive(client, previous.id_pengguna, previous.role))) {
        await client.query(
          `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
           WHERE token_family_id = $1`,
          [previous.token_family_id],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
      }

      const session = await this.createSessionInTransaction(
        client,
        { id: previous.id_pengguna, role: previous.role },
        previous.token_family_id,
        ip,
        userAgent,
      );
      const nextId = session.refreshRowId;
      await client.query(
        `UPDATE refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
        [previous.id, nextId],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return session.result;
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.pool.query(
      `UPDATE refresh_token
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE token_family_id = (
         SELECT token_family_id FROM refresh_token WHERE token_hash = $1
       )`,
      [this.hashToken(rawToken)],
    );
  }

  async getCurrentUser(user: AuthenticatedUser): Promise<AuthProfile | null> {
    const queryByRole: Record<UserRole, string> = {
      MAHASISWA: `SELECT id_mahasiswa::text AS id, 'MAHASISWA'::text AS role, nama, email::text AS email
                  FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
      PSIKOLOG: `SELECT id_psikolog::text AS id, 'PSIKOLOG'::text AS role, nama, email::text AS email
                 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
      DOSEN_ADMIN: `SELECT id_dosen::text AS id, 'DOSEN_ADMIN'::text AS role, nama, email::text AS email
                    FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
    };
    const result = await this.pool.query(queryByRole[user.role], [user.id]);
    return result.rows[0] ?? null;
  }

  private async issueSession(
    user: AuthenticatedUser,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await this.createSessionInTransaction(
        client,
        user,
        randomUUID(),
        ip,
        userAgent,
      );
      await client.query('COMMIT');
      return session.result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async createSessionInTransaction(
    client: PoolClient,
    user: AuthenticatedUser,
    familyId: string,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<{ result: AuthSession; refreshRowId: string }> {
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshSeconds = this.refreshTokenTtlSeconds();
    const refreshResult = await client.query<{ id: string }>(
      `INSERT INTO refresh_token
         (id_pengguna, role, token_hash, token_family_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6, $7)
       RETURNING id::text`,
      [
        user.id,
        user.role,
        this.hashToken(refreshToken),
        familyId,
        refreshSeconds,
        ip ?? null,
        userAgent?.slice(0, 512) ?? null,
      ],
    );
    const accessToken = await this.jwt.signAsync({ role: user.role, jti: randomUUID() }, {
      subject: user.id,
    });
    return {
      refreshRowId: refreshResult.rows[0].id,
      result: {
        accessToken,
        expiresIn: ACCESS_TOKEN_SECONDS,
        user,
        refreshToken,
        refreshTokenExpiresIn: refreshSeconds,
      },
    };
  }

  private async isAccountActive(
    client: PoolClient,
    id: string,
    role: UserRole,
  ): Promise<boolean> {
    const sql: Record<UserRole, string> = {
      MAHASISWA: `SELECT 1 FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
      PSIKOLOG: `SELECT 1 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
      DOSEN_ADMIN: `SELECT 1 FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
    };
    const result = await client.query(sql[role], [id]);
    return result.rowCount === 1;
  }

  private verifyTotp(encryptedSecret: Buffer, role: UserRole, id: string, otp: string): boolean {
    try {
      const table = role === 'PSIKOLOG' ? 'psikolog' : 'dosen_admin';
      const column = role === 'PSIKOLOG' ? 'id_psikolog' : 'id_dosen';
      const secretText = this.encryption
        .decrypt(encryptedSecret, `${table}:mfa_secret_enc:${id}`)
        .toString('utf8');
      const secret = decodeBase32(secretText);
      if (!/^\d{6}$/.test(otp)) return false;

      const nowStep = Math.floor(Date.now() / 30_000);
      for (let drift = -1; drift <= 1; drift++) {
        const counter = Buffer.alloc(8);
        counter.writeBigUInt64BE(BigInt(nowStep + drift));
        const digest = createHmac('sha1', secret).update(counter).digest();
        const offset = digest[digest.length - 1] & 0x0f;
        const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
        const expected = Buffer.from(code.toString().padStart(6, '0'));
        if (timingSafeEqual(expected, Buffer.from(otp))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private refreshTokenTtlSeconds(): number {
    const raw = process.env.REFRESH_TOKEN_TTL_SECONDS;
    if (!raw) return DEFAULT_REFRESH_TOKEN_SECONDS;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 60 || value > 30 * 24 * 60 * 60) {
      throw new Error('REFRESH_TOKEN_TTL_SECONDS harus berada antara 60 dan 2592000');
    }
    return value;
  }
}

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid TOTP secret');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of normalized) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}
