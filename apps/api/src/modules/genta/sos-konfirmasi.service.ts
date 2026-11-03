import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { AUTH_REDIS } from '../../common/auth/sso-state.lifecycle';
import { ensureRedisConnection } from '../../common/redis/redis.module';
import { gentaConfig } from './genta.constants';

/** Audience berbeda dari access token: token konfirmasi tidak bisa dipakai sebagai access token, dan sebaliknya. */
const AUDIENCE = 'dia-genta-konfirmasi';
const TUJUAN = 'GENTA_SOS_KONFIRMASI';

interface KonfirmasiClaims {
  sub: string;
  jti: string;
  tujuan: string;
  diterbitkan_ms: number;
}

export interface KonfirmasiTerbit {
  token_konfirmasi: string;
  berlaku_detik: number;
}

/**
 * Langkah konfirmasi tombol SOS (anti-iseng). Klien meminta token, menampilkan
 * pilihan situasi, lalu mengirim SOS dengan token tersebut. Token:
 * - ditandatangani server (RS256) dan terikat ke akun mahasiswa,
 * - berumur pendek, wajib melewati jeda minimal (menahan klik otomatis/skrip),
 * - sekali pakai (Redis); bila Redis tidak tersedia, pengecekan sekali-pakai dilewati
 *   (fail-open) karena SOS adalah fitur keselamatan dan dedupe DB tetap berlaku.
 */
@Injectable()
export class SosKonfirmasiService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async terbitkan(idMahasiswa: string): Promise<KonfirmasiTerbit> {
    const ttl = gentaConfig.konfirmasiTtlDetik();
    const token = await this.jwt.signAsync(
      { tujuan: TUJUAN, diterbitkan_ms: Date.now() },
      { subject: idMahasiswa, audience: AUDIENCE, expiresIn: ttl, jwtid: randomUUID() },
    );
    return { token_konfirmasi: token, berlaku_detik: ttl };
  }

  /** Memverifikasi token; melempar 422 dengan kode yang bisa ditangani FE (minta token baru). */
  async verifikasi(idMahasiswa: string, token: string): Promise<{ jti: string }> {
    let claims: KonfirmasiClaims;
    try {
      claims = await this.jwt.verifyAsync<KonfirmasiClaims>(token, {
        algorithms: ['RS256'],
        audience: AUDIENCE,
      });
    } catch {
      throw this.tidakValid('KONFIRMASI_TIDAK_VALID', 'Konfirmasi tidak valid atau kedaluwarsa, ulangi konfirmasi');
    }
    if (claims.tujuan !== TUJUAN || claims.sub !== idMahasiswa || typeof claims.jti !== 'string' ||
        !Number.isSafeInteger(claims.diterbitkan_ms)) {
      throw this.tidakValid('KONFIRMASI_TIDAK_VALID', 'Konfirmasi tidak valid, ulangi konfirmasi');
    }
    if (Date.now() - claims.diterbitkan_ms < gentaConfig.jedaMinimalMs()) {
      throw this.tidakValid('KONFIRMASI_TERLALU_CEPAT', 'Konfirmasi terlalu cepat, pastikan pilihan situasi sudah benar');
    }
    return { jti: claims.jti };
  }

  /** Menandai token terpakai. `false` berarti token sudah pernah dipakai. */
  async pakai(jti: string): Promise<boolean> {
    try {
      await ensureRedisConnection(this.redis);
      const saved = await this.redis.set(
        `genta:konfirmasi:${jti}`, '1', 'EX', gentaConfig.konfirmasiTtlDetik() + 60, 'NX',
      );
      return saved === 'OK';
    } catch {
      return true;
    }
  }

  private tidakValid(kode: string, pesan: string): UnprocessableEntityException {
    return new UnprocessableEntityException({ kode, pesan });
  }
}
