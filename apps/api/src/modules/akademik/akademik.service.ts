import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AUTH_REDIS } from '../../common/auth/sso-state.lifecycle';
import { ensureRedisConnection } from '../../common/redis/redis.module';
import { intEnv } from '../../common/domain/env';
import { AKADEMIK_CLIENT, AkademikClient, AkademikStatus } from './akademik.types';

const CACHE_SECONDS = 24 * 60 * 60;
/** Setelah API akademik gagal, panggilan berikutnya dilewati selama ini (circuit breaker). */
export const SIRKUIT_TERBUKA_MS = 30_000;

/**
 * Toleransi gangguan (jam): saat API akademik tidak dapat dihubungi, akun yang terakhir
 * terverifikasi AKTIF dalam rentang ini tetap diterima. Harus > 24 jam (interval
 * re-verifikasi), kalau tidak fallback tidak pernah berlaku di guard (SCRUM-210).
 */
export const toleransiGangguanJam = () => intEnv('AKADEMIK_TOLERANSI_GANGGUAN_JAM', 72, 24, 24 * 14);

@Injectable()
export class AkademikService {
  private readonly logger = new Logger(AkademikService.name);
  /** Epoch ms sampai kapan API akademik dianggap gangguan (per instance). */
  private gangguanSampai = 0;

  constructor(
    @Inject(AKADEMIK_CLIENT) private readonly client: AkademikClient,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async verifikasi(nim: string): Promise<AkademikStatus> {
    const key = this.cacheKey(nim);
    try {
      await ensureRedisConnection(this.redis);
      const cached = await this.redis.get(key);
      if (cached === 'aktif' || cached === 'tidak_aktif') {
        return { aktif: cached === 'aktif', sumber: 'cache' };
      }
    } catch {
      // Cache is an optimization. The authoritative client and DB fallback still apply.
    }

    // Circuit breaker: selama API dianggap gangguan, jangan menunggu timeout 3 dtk di tiap request.
    if (Date.now() < this.gangguanSampai) return this.fallback(nim);
    let aktif: boolean;
    try {
      aktif = await this.client.cekStatus(nim);
    } catch {
      this.gangguanSampai = Date.now() + SIRKUIT_TERBUKA_MS;
      this.logger.warn(`API akademik gangguan; memakai status DB selama ${SIRKUIT_TERBUKA_MS / 1000} dtk`);
      return this.fallback(nim);
    }
    this.gangguanSampai = 0;
    await this.persistStatus(nim, aktif);
    try {
      await ensureRedisConnection(this.redis);
      await this.redis.set(key, aktif ? 'aktif' : 'tidak_aktif', 'EX', CACHE_SECONDS);
    } catch {
      // A DB status and verification timestamp remain available for bounded outage fallback.
    }
    return { aktif, sumber: 'api' };
  }

  /**
   * Status dari DB saat API akademik gangguan: akun tidak aktif tetap ditolak; akun aktif
   * diterima bila terverifikasi dalam `AKADEMIK_TOLERANSI_GANGGUAN_JAM`; selain itu 503.
   * Akun baru (belum pernah terverifikasi) gagal tertutup.
   */
  private async fallback(nim: string): Promise<AkademikStatus> {
    const last = await this.pool.query<{ status_aktif: boolean; terakhir_verifikasi_at: Date | null }>(
      `SELECT status_aktif, terakhir_verifikasi_at FROM mahasiswa
       WHERE nim = $1 AND deleted_at IS NULL`,
      [nim],
    );
    const row = last.rows[0];
    if (row && !row.status_aktif) return { aktif: false, sumber: 'cache' };
    if (row?.status_aktif && row.terakhir_verifikasi_at &&
        Date.now() - new Date(row.terakhir_verifikasi_at).getTime() <= toleransiGangguanJam() * 3_600_000) {
      return { aktif: true, sumber: 'cache' };
    }
    throw new ServiceUnavailableException('Status akademik belum dapat diverifikasi');
  }

  async wajibAktif(nim: string): Promise<AkademikStatus> {
    const status = await this.verifikasi(nim);
    if (!status.aktif) throw new ForbiddenException('AKUN_TIDAK_AKTIF');
    return status;
  }

  private async persistStatus(nim: string, aktif: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE mahasiswa SET status_aktif = $2, terakhir_verifikasi_at = now(), updated_at = now()
       WHERE nim = $1 AND deleted_at IS NULL`,
      [nim, aktif],
    );
  }

  /**
   * Hapus cache status akademik sebuah NIM (mis. setelah akun mahasiswa dihapus/dianonimkan)
   * agar NIM asli tidak tersisa di Redis. Best-effort: kegagalan Redis tidak membatalkan
   * operasi pemanggil. @returns `true` bila ada entri yang dihapus.
   */
  async hapusCache(nim: string): Promise<boolean> {
    try {
      await ensureRedisConnection(this.redis);
      return (await this.redis.del(this.cacheKey(nim))) > 0;
    } catch {
      return false;
    }
  }

  private cacheKey(nim: string): string {
    return `akademik:${nim}`;
  }
}
