import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { sqlSedangJaga, zonaWaktuJadwal } from '../../common/domain/zona-waktu';

/**
 * Sinkronisasi `psikolog.status_jaga` dari `jadwal_jaga` setiap menit (02-backend.md §8.3).
 * `status_jaga` hanya turunan untuk tampilan; pencarian penerima notifikasi SOS tetap
 * membaca `jadwal_jaga` langsung (04-database.md §4.f). Hanya baris yang berubah ditulis.
 */
@Injectable()
export class StatusJagaSync {
  private readonly logger = new Logger(StatusJagaSync.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Interval('status-jaga-sync', 60_000)
  async sinkron(): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE psikolog p
         SET status_jaga = target.jaga
         FROM (
           SELECT p2.id_psikolog,
                  (p2.status_akun = 'AKTIF' AND EXISTS (
                    SELECT 1 FROM jadwal_jaga j WHERE j.id_psikolog = p2.id_psikolog AND ${sqlSedangJaga('$1')}
                  )) AS jaga
           FROM psikolog p2
         ) target
         WHERE p.id_psikolog = target.id_psikolog AND p.status_jaga IS DISTINCT FROM target.jaga`,
        [zonaWaktuJadwal()],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      this.logger.error(`Sinkronisasi status_jaga gagal: ${(error as Error).message}`);
      return 0;
    }
  }
}
