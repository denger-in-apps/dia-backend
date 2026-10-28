import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AUTH_REDIS } from '../../common/auth/sso-state.lifecycle';
import { AKADEMIK_CLIENT, AkademikClient, AkademikStatus } from './akademik.types';

const CACHE_SECONDS = 24 * 60 * 60;
const FRESH_VERIFICATION_MS = CACHE_SECONDS * 1000;

@Injectable()
export class AkademikService {
  constructor(
    @Inject(AKADEMIK_CLIENT) private readonly client: AkademikClient,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async verifikasi(nim: string): Promise<AkademikStatus> {
    const key = this.cacheKey(nim);
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const cached = await this.redis.get(key);
      if (cached === 'aktif' || cached === 'tidak_aktif') {
        return { aktif: cached === 'aktif', sumber: 'cache' };
      }
    } catch {
      // Cache is an optimization. The authoritative client and DB fallback still apply.
    }

    try {
      const aktif = await this.client.cekStatus(nim);
      await this.persistStatus(nim, aktif);
      try {
        if (this.redis.status === 'wait') await this.redis.connect();
        await this.redis.set(key, aktif ? 'aktif' : 'tidak_aktif', 'EX', CACHE_SECONDS);
      } catch {
        // A DB status and verification timestamp remain available for bounded outage fallback.
      }
      return { aktif, sumber: 'api' };
    } catch {
      const last = await this.pool.query<{ status_aktif: boolean; terakhir_verifikasi_at: Date | null }>(
        `SELECT status_aktif, terakhir_verifikasi_at FROM mahasiswa
         WHERE nim = $1 AND deleted_at IS NULL`,
        [nim],
      );
      const row = last.rows[0];
      if (row?.status_aktif && row.terakhir_verifikasi_at &&
          Date.now() - new Date(row.terakhir_verifikasi_at).getTime() <= FRESH_VERIFICATION_MS) {
        return { aktif: true, sumber: 'cache' };
      }
      if (row && !row.status_aktif) return { aktif: false, sumber: 'cache' };
      throw new ServiceUnavailableException('Status akademik belum dapat diverifikasi');
    }
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

  private cacheKey(nim: string): string {
    return `akademik:${nim}`;
  }
}
