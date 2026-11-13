import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { ensureRedisConnection } from '../redis/redis.module';
import { AUTH_REDIS } from './sso-state.lifecycle';

/** Ambang lockout bertahap: [jumlah gagal, lama kunci (detik)], dari yang terberat. */
export const AMBANG_LOCKOUT: readonly [number, number][] = [
  [10, 15 * 60],
  [5, 60],
];
/** Jendela penghitungan kegagalan. */
export const JENDELA_GAGAL_DETIK = 60 * 60;

/**
 * Lockout bertahap per akun staf (02-backend.md §5.3, SCRUM-208), melengkapi throttle per IP.
 * Kunci = hash(role + email) sehingga email tidak tersimpan polos di Redis, dan berlaku sama
 * untuk email yang tidak terdaftar (tidak membocorkan email mana yang ada). Bila Redis tidak
 * tersedia, lockout dilewati (fail-open) karena throttle IP tetap berlaku.
 */
@Injectable()
export class LockoutLoginService {
  private readonly logger = new Logger(LockoutLoginService.name);

  constructor(@Inject(AUTH_REDIS) private readonly redis: Redis) {}

  /** Lempar 429 `AKUN_TERKUNCI_SEMENTARA` bila akun sedang dikunci. */
  async pastikanTidakTerkunci(role: string, email: string): Promise<void> {
    const sisa = await this.aman(async () => this.redis.ttl(this.kunciLock(role, email)), -2);
    if (sisa > 0) {
      throw new HttpException({
        kode: 'AKUN_TERKUNCI_SEMENTARA',
        pesan: 'Terlalu banyak percobaan login gagal. Coba lagi nanti.',
        detail: { coba_lagi_detik: sisa },
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Catat kegagalan; kunci akun bila melewati ambang. @returns jumlah gagal dalam jendela. */
  async catatGagal(role: string, email: string): Promise<number> {
    return this.aman(async () => {
      const kunci = this.kunciGagal(role, email);
      const [[, jumlah]] = (await this.redis.multi().incr(kunci).expire(kunci, JENDELA_GAGAL_DETIK, 'NX').exec()) as [
        [Error | null, number], [Error | null, number],
      ];
      const ambang = AMBANG_LOCKOUT.find(([batas]) => jumlah >= batas);
      if (ambang) await this.redis.set(this.kunciLock(role, email), '1', 'EX', ambang[1]);
      return jumlah;
    }, 0);
  }

  async reset(role: string, email: string): Promise<void> {
    await this.aman(async () => this.redis.del(this.kunciGagal(role, email)), 0);
  }

  private async aman<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    try {
      await ensureRedisConnection(this.redis);
      return await work();
    } catch (error) {
      this.logger.warn(`Lockout login dilewati (Redis tidak tersedia): ${(error as Error).message}`);
      return fallback;
    }
  }

  private id(role: string, email: string): string {
    return createHash('sha256').update(`${role}:${email.trim().toLowerCase()}`).digest('hex').slice(0, 32);
  }

  private kunciGagal(role: string, email: string): string {
    return `auth:login:gagal:${this.id(role, email)}`;
  }

  private kunciLock(role: string, email: string): string {
    return `auth:login:kunci:${this.id(role, email)}`;
  }
}
