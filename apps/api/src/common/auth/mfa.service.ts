import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { EncryptionService } from '../crypto/encryption.service';
import { ensureRedisConnection } from '../redis/redis.module';
import { AuthService } from './auth.service';
import { AuthSession } from './auth.types';
import { MFA_SETUP_TTL_DETIK, MfaTokenService, RoleStaf } from './mfa-token.service';
import { AUTH_REDIS } from './sso-state.lifecycle';
import { buatSecretTotp, cocokkanTotp, otpauthUrl } from './totp';

export interface MulaiMfa {
  /** Secret base32 untuk dimasukkan manual bila QR tidak dapat dipindai. */
  secret: string;
  /** Tampilkan sebagai QR code di FE. */
  otpauth_url: string;
  berlaku_detik: number;
}

const TABEL: Record<RoleStaf, { tabel: string; kolom: string }> = {
  PSIKOLOG: { tabel: 'psikolog', kolom: 'id_psikolog' },
  DOSEN_ADMIN: { tabel: 'dosen_admin', kolom: 'id_dosen' },
};

/**
 * Pendaftaran MFA TOTP untuk staf (SCRUM-208). Alur:
 * 1. `POST /auth/staff/login` saat MFA wajib & belum terdaftar → `403 MFA_WAJIB` + `mfa_setup_token`
 *    (atau `POST /auth/staff/mfa/token` bagi staf yang sudah login).
 * 2. `POST /auth/staff/mfa/mulai` → secret baru (disimpan terenkripsi di Redis 10 menit).
 * 3. `POST /auth/staff/mfa/aktifkan` dengan OTP dari authenticator → secret disimpan permanen
 *    (`mfa_secret_enc`, AES-GCM + AAD) dan sesi diterbitkan.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
    private readonly encryption: EncryptionService,
    private readonly mfaToken: MfaTokenService,
    private readonly auth: AuthService,
  ) {}

  async mulai(setupToken: string): Promise<MulaiMfa> {
    const user = await this.mfaToken.verifikasi(setupToken);
    const akun = await this.akunTanpaMfa(user);
    const secret = buatSecretTotp();
    const pending = this.encryption.encrypt(secret, this.aadPending(user)).toString('base64');
    await this.redisAman(() => this.redis.set(this.kunciPending(user), pending, 'EX', MFA_SETUP_TTL_DETIK));
    return { secret, otpauth_url: otpauthUrl(secret, akun.email), berlaku_detik: MFA_SETUP_TTL_DETIK };
  }

  async aktifkan(setupToken: string, otp: string, ip?: string, userAgent?: string): Promise<AuthSession> {
    const user = await this.mfaToken.verifikasi(setupToken);
    await this.akunTanpaMfa(user);
    const pending = await this.redisAman(() => this.redis.get(this.kunciPending(user)));
    if (!pending) {
      throw new UnauthorizedException({ kode: 'MFA_BELUM_DIMULAI', pesan: 'Mulai pendaftaran MFA terlebih dahulu' });
    }
    const secret = this.encryption.decrypt(Buffer.from(pending, 'base64'), this.aadPending(user)).toString('utf8');
    const step = cocokkanTotp(secret, otp);
    if (step === null || !(await this.auth.consumeTotpStep(user.role, user.id, step))) {
      throw new UnauthorizedException({ kode: 'OTP_SALAH', pesan: 'Kode OTP salah atau sudah dipakai' });
    }

    const { tabel, kolom } = TABEL[user.role];
    const result = await this.pool.query(
      `UPDATE ${tabel} SET mfa_secret_enc = $2 WHERE ${kolom} = $1 AND mfa_secret_enc IS NULL`,
      [user.id, this.encryption.encrypt(secret, `${tabel}:mfa_secret_enc:${user.id}`)],
    );
    if (result.rowCount !== 1) throw this.sudahAktif();
    await this.redisAman(() => this.redis.del(this.kunciPending(user))).catch(() => undefined);
    return this.auth.terbitkanSesiStaf({ id: user.id, role: user.role }, ip, userAgent);
  }

  /** Token pendaftaran untuk staf yang sudah login (MFA belum wajib, aktivasi sukarela). */
  async tokenUntukStafLogin(user: { id: string; role: RoleStaf }): Promise<{ mfa_setup_token: string; berlaku_detik: number }> {
    await this.akunTanpaMfa(user);
    return { mfa_setup_token: await this.mfaToken.terbitkan(user), berlaku_detik: MFA_SETUP_TTL_DETIK };
  }

  private async akunTanpaMfa(user: { id: string; role: RoleStaf }): Promise<{ email: string }> {
    const { tabel, kolom } = TABEL[user.role];
    const aktif = user.role === 'PSIKOLOG' ? `status_akun = 'AKTIF'` : 'aktif';
    const result = await this.pool.query<{ email: string; ada_mfa: boolean }>(
      `SELECT email::text AS email, (mfa_secret_enc IS NOT NULL) AS ada_mfa FROM ${tabel}
       WHERE ${kolom} = $1 AND ${aktif}`,
      [user.id],
    );
    const akun = result.rows[0];
    if (!akun) throw new UnauthorizedException({ kode: 'MFA_TOKEN_TIDAK_VALID', pesan: 'Akun tidak aktif' });
    if (akun.ada_mfa) throw this.sudahAktif();
    return akun;
  }

  private async redisAman<T>(work: () => Promise<T>): Promise<T> {
    try {
      await ensureRedisConnection(this.redis);
      return await work();
    } catch (error) {
      throw new ServiceUnavailableException('Pendaftaran MFA sementara tidak tersedia', { cause: error });
    }
  }

  private kunciPending(user: { id: string; role: RoleStaf }): string {
    return `auth:mfa:pending:${user.role}:${user.id}`;
  }

  private aadPending(user: { id: string; role: RoleStaf }): string {
    return `mfa_pending:${user.role}:${user.id}`;
  }

  private sudahAktif(): ConflictException {
    return new ConflictException({
      kode: 'MFA_SUDAH_AKTIF',
      pesan: 'MFA sudah aktif untuk akun ini; minta Dosen Admin/operator bila perlu reset',
    });
  }
}
