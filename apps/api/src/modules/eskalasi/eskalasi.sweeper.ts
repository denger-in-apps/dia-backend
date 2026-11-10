import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { SAPU_TOLERANSI_DETIK } from './eskalasi.constants';
import { EskalasiService } from './eskalasi.service';

/**
 * Jaring pengaman timer eskalasi: setiap 30 detik mencari SOS `BARU` yang sudah melewati
 * durasi eskalasi (+ toleransi) — mis. karena Redis mati saat SOS dibuat atau job hilang —
 * lalu mengeskalasinya. Aman berjalan di semua instance karena eskalasi bersifat atomik.
 */
@Injectable()
export class EskalasiSweeper {
  private readonly logger = new Logger(EskalasiSweeper.name);
  private berjalan = false;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly eskalasi: EskalasiService,
  ) {}

  @Interval('eskalasi-sapu', 30_000)
  async sapu(): Promise<number> {
    if (this.berjalan) return 0;
    this.berjalan = true;
    try {
      const result = await this.pool.query<{ id_sos: string }>(
        `SELECT s.id_sos::text AS id_sos
         FROM log_sos s
         CROSS JOIN LATERAL (
           SELECT COALESCE((SELECT durasi_eskalasi_detik FROM konfigurasi_sos WHERE id = 1), 180) AS durasi
         ) k
         WHERE s.status_penanganan = 'BARU'
           AND s.waktu_kejadian <= now() - make_interval(secs => k.durasi + $1)
         ORDER BY s.prioritas DESC, s.waktu_kejadian
         LIMIT 50`,
        [SAPU_TOLERANSI_DETIK],
      );
      let jumlah = 0;
      for (const { id_sos } of result.rows) {
        if (await this.eskalasi.eskalasi(id_sos, 'SAPU')) jumlah++;
      }
      return jumlah;
    } catch (error) {
      this.logger.error(`Sweeper eskalasi gagal: ${(error as Error).message}`);
      return 0;
    } finally {
      this.berjalan = false;
    }
  }
}
