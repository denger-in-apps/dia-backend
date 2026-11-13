import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID, createHash } from 'crypto';
import * as argon2 from 'argon2';
import { Pool, PoolClient } from 'pg';
import { EncryptionService } from '../crypto/encryption.service';
import { DATABASE_POOL } from '../../database/database.module';
import { AuthProfile, AuthSession, AuthenticatedUser, UserRole } from './auth.types';
import { StudentIdentity } from './oidc-sso.strategy';
import { AkademikService } from '../../modules/akademik/akademik.service';
import Redis from 'ioredis';
import { AUTH_REDIS } from './sso-state.lifecycle';
import { ensureRedisConnection } from '../redis/redis.module';
import { cocokkanTotp, TOTP_DRIFT_STEPS, TOTP_STEP_MS } from './totp';
import { MfaTokenService } from './mfa-token.service';

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
const DEFAULT_REFRESH_REUSE_GRACE_SECONDS = 10;
const STUDENT_REVERIFY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly encryption: EncryptionService,
    private readonly akademik: AkademikService,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
    private readonly mfaToken: MfaTokenService,
  ) {}

  /** Hash dummy agar email yang tidak terdaftar tetap menjalankan argon2 (anti-enumerasi). */
  private dummyHash?: Promise<string>;

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

    let passwordIsValid = false;
    try {
      // Selalu jalankan argon2 (dengan hash dummy bila akun tidak ada) supaya waktu
      // respons tidak membocorkan email mana yang terdaftar.
      const hash = account?.password_hash ?? (await this.getDummyHash());
      passwordIsValid = await argon2.verify(hash, password);
    } catch {
      passwordIsValid = false;
    }
    if (!account?.password_hash || !passwordIsValid) {
      throw new UnauthorizedException('Email atau password salah');
    }
    if (!account.aktif) throw new ForbiddenException('Akun staf belum aktif');

    if (account.mfa_secret_enc) {
      const step = otp ? this.verifyTotp(account.mfa_secret_enc, role, account.id, otp) : null;
      if (step === null || !(await this.consumeTotpStep(role, account.id, step))) {
        throw new UnauthorizedException('Email atau password salah');
      }
    } else if (otp) {
      throw new UnauthorizedException('Email atau password salah');
    } else if (this.staffMfaRequired()) {
      // Password sudah benar: beri token pendaftaran MFA sekali pakai (10 menit) agar staf
      // dapat mendaftarkan authenticator tanpa sesi penuh (POST /auth/staff/mfa/mulai).
      throw new ForbiddenException({
        kode: 'MFA_WAJIB',
        pesan: 'MFA wajib; daftarkan aplikasi authenticator terlebih dahulu',
        mfa_setup_token: await this.mfaToken.terbitkan({ id: account.id, role }),
      });
    }

    return this.issueSession({ id: account.id, role }, ip, userAgent);
  }

  async loginStudent(
    identity: StudentIdentity,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    const academicStatus = await this.akademik.wajibAktif(identity.nim);
    let result;
    try {
      result = await this.pool.query(
        `INSERT INTO mahasiswa (sso_subject, nim, email, nama, status_aktif, terakhir_verifikasi_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (nim) DO UPDATE
           SET sso_subject = EXCLUDED.sso_subject,
               email = EXCLUDED.email,
               nama = EXCLUDED.nama,
               status_aktif = EXCLUDED.status_aktif,
               terakhir_verifikasi_at = now(),
               updated_at = now()
         WHERE mahasiswa.deleted_at IS NULL
           AND (mahasiswa.sso_subject IS NULL OR mahasiswa.sso_subject = EXCLUDED.sso_subject)
         RETURNING id_mahasiswa::text AS id, status_aktif, deleted_at`,
        [identity.subject, identity.nim, identity.email, identity.name, academicStatus.aktif],
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
    rawToken: string | undefined,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<AuthSession> {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
    }
    const tokenHash = this.hashToken(rawToken);
    // Panggilan HTTP ke layanan akademik dilakukan SEBELUM transaksi dibuka agar tidak
    // menahan koneksi pool + row lock selama menunggu jaringan (risiko pool exhaustion).
    const studentStillActive = await this.reverifyStudentIfStale(tokenHash);
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

      const graceReuse = Boolean(previous.revoked_at) &&
        (await this.isWithinReuseGrace(client, previous));
      if (previous.revoked_at && !graceReuse) {
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
      if (!(await this.isAccountActive(
        client, previous.id_pengguna, previous.role, studentStillActive,
      ))) {
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
      if (!graceReuse) {
        await client.query(
          `UPDATE refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
          [previous.id, session.refreshRowId],
        );
      }
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
      MAHASISWA: `SELECT id_mahasiswa::text AS id, 'MAHASISWA'::text AS role, nama, email::text AS email,
                         false AS wajib_ganti_password
                  FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
      PSIKOLOG: `SELECT id_psikolog::text AS id, 'PSIKOLOG'::text AS role, nama, email::text AS email,
                        wajib_ganti_password
                 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
      DOSEN_ADMIN: `SELECT id_dosen::text AS id, 'DOSEN_ADMIN'::text AS role, nama, email::text AS email,
                           wajib_ganti_password
                    FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
    };
    const result = await this.pool.query(queryByRole[user.role], [user.id]);
    return result.rows[0] ?? null;
  }

  /**
   * Staf mengganti password sendiri (mis. password sementara dari admin). Password lama
   * wajib benar; password baru minimal 12 karakter dan berbeda. Semua sesi lain dicabut.
   */
  async gantiPasswordStaf(
    user: AuthenticatedUser,
    passwordLama: string,
    passwordBaru: string,
  ): Promise<void> {
    if (user.role === 'MAHASISWA') {
      throw new ForbiddenException('Password mahasiswa dikelola SSO kampus');
    }
    const table = user.role === 'PSIKOLOG' ? 'psikolog' : 'dosen_admin';
    const column = user.role === 'PSIKOLOG' ? 'id_psikolog' : 'id_dosen';
    const result = await this.pool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM ${table} WHERE ${column} = $1`,
      [user.id],
    );
    const hash = result.rows[0]?.password_hash;
    let valid = false;
    try {
      valid = !!hash && await argon2.verify(hash, passwordLama);
    } catch {
      valid = false;
    }
    if (!valid) throw new UnauthorizedException('Password lama salah');
    if (passwordLama === passwordBaru) {
      throw new ForbiddenException('Password baru harus berbeda dari password lama');
    }
    const newHash = await argon2.hash(passwordBaru, { type: argon2.argon2id });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${table} SET password_hash = $2, wajib_ganti_password = false WHERE ${column} = $1`,
        [user.id, newHash],
      );
      await client.query(
        `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
         WHERE id_pengguna = $1 AND role = $2`,
        [user.id, user.role],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Terbitkan sesi staf setelah faktor login terpenuhi di alur lain (mis. aktivasi MFA). */
  terbitkanSesiStaf(user: AuthenticatedUser, ip: string | undefined, userAgent: string | undefined): Promise<AuthSession> {
    return this.issueSession(user, ip, userAgent);
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

  /**
   * Refresh paralel dari beberapa tab membawa cookie lama yang sama. Dalam jendela
   * singkat setelah rotasi, token lama masih boleh dipakai SELAMA penerusnya belum
   * dicabut (logout/deteksi reuse mencabut seluruh family, sehingga grace gugur).
   * Penerus tidak dicabut agar cookie mana pun yang terakhir tersimpan tetap valid.
   */
  private async isWithinReuseGrace(client: PoolClient, previous: RefreshRow): Promise<boolean> {
    if (!previous.revoked_at || !previous.replaced_by) return false;
    const graceMs = this.refreshReuseGraceSeconds() * 1000;
    if (graceMs === 0 || Date.now() - new Date(previous.revoked_at).getTime() > graceMs) {
      return false;
    }
    const successor = await client.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM refresh_token WHERE id = $1 FOR UPDATE`,
      [previous.replaced_by],
    );
    return successor.rows.length === 1 && successor.rows[0].revoked_at === null;
  }

  /**
   * Untuk refresh token mahasiswa yang status akademiknya sudah >24 jam tidak
   * diverifikasi, cek ulang ke layanan akademik di luar transaksi.
   * Mengembalikan `undefined` bila tidak perlu (bukan mahasiswa / masih segar).
   */
  private async reverifyStudentIfStale(tokenHash: string): Promise<boolean | undefined> {
    const result = await this.pool.query<{ nim: string; terakhir_verifikasi_at: Date | null }>(
      `SELECT m.nim, m.terakhir_verifikasi_at
       FROM refresh_token rt
       JOIN mahasiswa m ON m.id_mahasiswa = rt.id_pengguna
       WHERE rt.token_hash = $1 AND rt.role = 'MAHASISWA'
         AND m.status_aktif AND m.deleted_at IS NULL`,
      [tokenHash],
    );
    const student = result.rows[0];
    if (!student) return undefined;
    if (student.terakhir_verifikasi_at &&
        Date.now() - new Date(student.terakhir_verifikasi_at).getTime() < STUDENT_REVERIFY_MS) {
      return undefined;
    }
    const status = await this.akademik.verifikasi(student.nim);
    return status.aktif;
  }

  private async isAccountActive(
    client: PoolClient,
    id: string,
    role: UserRole,
    studentStillActive?: boolean,
  ): Promise<boolean> {
    if (role === 'MAHASISWA' && studentStillActive === false) return false;
    const sql: Record<UserRole, string> = {
      MAHASISWA: `SELECT 1 FROM mahasiswa WHERE id_mahasiswa = $1 AND status_aktif AND deleted_at IS NULL`,
      PSIKOLOG: `SELECT 1 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
      DOSEN_ADMIN: `SELECT 1 FROM dosen_admin WHERE id_dosen = $1 AND aktif`,
    };
    const result = await client.query(sql[role], [id]);
    return result.rowCount === 1;
  }

  /** Mengembalikan time-step yang cocok, atau null bila OTP salah. */
  private verifyTotp(encryptedSecret: Buffer, role: UserRole, id: string, otp: string): number | null {
    try {
      const table = role === 'PSIKOLOG' ? 'psikolog' : 'dosen_admin';
      const secretText = this.encryption
        .decrypt(encryptedSecret, `${table}:mfa_secret_enc:${id}`)
        .toString('utf8');
      return cocokkanTotp(secretText, otp);
    } catch {
      return null;
    }
  }

  /**
   * Menandai time-step OTP sebagai terpakai (SET NX) agar kode yang sama tidak bisa
   * di-replay dalam jendela validitasnya. Fail-closed bila Redis tidak tersedia.
   */
  async consumeTotpStep(role: UserRole, id: string, step: number): Promise<boolean> {
    const ttlSeconds = Math.ceil(((TOTP_DRIFT_STEPS * 2 + 1) * TOTP_STEP_MS) / 1000);
    try {
      await ensureRedisConnection(this.redis);
      const saved = await this.redis.set(
        `auth:totp:used:${role}:${id}:${step}`, '1', 'EX', ttlSeconds, 'NX',
      );
      return saved === 'OK';
    } catch (error) {
      throw new ServiceUnavailableException('Verifikasi MFA sementara tidak tersedia', { cause: error });
    }
  }

  private staffMfaRequired(): boolean {
    const raw = process.env.STAFF_MFA_REQUIRED?.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return process.env.NODE_ENV === 'production';
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(randomBytes(32), { type: argon2.argon2id });
    return this.dummyHash;
  }

  private refreshReuseGraceSeconds(): number {
    const raw = process.env.REFRESH_REUSE_GRACE_SECONDS;
    if (!raw) return DEFAULT_REFRESH_REUSE_GRACE_SECONDS;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 60) {
      throw new Error('REFRESH_REUSE_GRACE_SECONDS harus berada antara 0 dan 60');
    }
    return value;
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
