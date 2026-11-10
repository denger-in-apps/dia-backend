import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';

export interface KonfigurasiSos {
  durasi_eskalasi_detik: number;
  eskalasi_segera_jika_tidak_ada_psikolog: boolean;
  hotline_label: string;
  hotline_aktif: boolean;
  updated_at: Date | null;
}

/** Nilai default skema (`konfigurasi_sos`) bila baris singleton belum ada. */
export const KONFIGURASI_DEFAULT: KonfigurasiSos = {
  durasi_eskalasi_detik: 180,
  eskalasi_segera_jika_tidak_ada_psikolog: true,
  hotline_label: 'Healing119.id — 119 ext. 8',
  hotline_aktif: true,
  updated_at: null,
};

/**
 * Konfigurasi SOS dibaca dari DB (bukan env) agar dapat diubah Dosen Admin saat
 * runtime tanpa deploy (02-backend.md §4). Dibaca setiap kali dipakai — barisnya kecil.
 */
@Injectable()
export class KonfigurasiSosService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async ambil(): Promise<KonfigurasiSos> {
    const result = await this.pool.query<KonfigurasiSos>(
      `SELECT durasi_eskalasi_detik, eskalasi_segera_jika_tidak_ada_psikolog,
              hotline_label, hotline_aktif, updated_at
       FROM konfigurasi_sos WHERE id = 1`,
    );
    return result.rows[0] ?? KONFIGURASI_DEFAULT;
  }
}
