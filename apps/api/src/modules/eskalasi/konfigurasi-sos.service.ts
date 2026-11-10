import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';

export interface KonfigurasiSos {
  durasi_eskalasi_detik: number;
  eskalasi_segera_jika_tidak_ada_psikolog: boolean;
  hotline_label: string;
  hotline_aktif: boolean;
  /** SMS ke kontak darurat mahasiswa saat eskalasi. */
  kontak_darurat_aktif: boolean;
  /** Kabari kontak darurat juga untuk SOS `perlu_verifikasi` non-kritis (default tidak). */
  kontak_darurat_untuk_perlu_verifikasi: boolean;
  /** Batas eskalasi yang mengabari kontak darurat per mahasiswa per 24 jam. */
  maks_eskalasi_kontak_per_hari: number;
  /** Anti-penyalahgunaan tombol Genta (PBI-05): SOS baru per akun per jam. */
  sos_maks_per_jam: number;
  /** Laporan tidak valid dalam 30 hari yang memicu `perlu_verifikasi`. */
  sos_ambang_iseng_30_hari: number;
  /** Pembatalan dalam 24 jam yang memicu `perlu_verifikasi`. */
  sos_ambang_batal_24_jam: number;
  diubah_oleh: string | null;
  updated_at: Date | null;
}

export type KonfigurasiSosUbah = Partial<Omit<KonfigurasiSos, 'diubah_oleh' | 'updated_at'>>;

/** Nilai default skema (`konfigurasi_sos`) bila baris singleton belum ada. */
export const KONFIGURASI_DEFAULT: KonfigurasiSos = {
  durasi_eskalasi_detik: 180,
  eskalasi_segera_jika_tidak_ada_psikolog: true,
  hotline_label: 'Healing119.id — 119 ext. 8',
  hotline_aktif: true,
  kontak_darurat_aktif: true,
  kontak_darurat_untuk_perlu_verifikasi: false,
  maks_eskalasi_kontak_per_hari: 3,
  sos_maks_per_jam: 5,
  sos_ambang_iseng_30_hari: 2,
  sos_ambang_batal_24_jam: 3,
  diubah_oleh: null,
  updated_at: null,
};

/** Kolom yang dapat diubah admin; urutan ini juga menjadi whitelist kolom UPDATE. */
const KOLOM_UBAH = [
  'durasi_eskalasi_detik',
  'eskalasi_segera_jika_tidak_ada_psikolog',
  'hotline_label',
  'hotline_aktif',
  'kontak_darurat_aktif',
  'kontak_darurat_untuk_perlu_verifikasi',
  'maks_eskalasi_kontak_per_hari',
  'sos_maks_per_jam',
  'sos_ambang_iseng_30_hari',
  'sos_ambang_batal_24_jam',
] as const satisfies readonly (keyof KonfigurasiSosUbah)[];

const SELECT_KOLOM = `${KOLOM_UBAH.join(', ')}, diubah_oleh::text AS diubah_oleh, updated_at`;

/**
 * Konfigurasi SOS dibaca dari DB (bukan env) agar dapat diubah Dosen Admin saat
 * runtime tanpa deploy (02-backend.md §4). Dibaca setiap kali dipakai — barisnya kecil.
 */
@Injectable()
export class KonfigurasiSosService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async ambil(): Promise<KonfigurasiSos> {
    const result = await this.pool.query<KonfigurasiSos>(`SELECT ${SELECT_KOLOM} FROM konfigurasi_sos WHERE id = 1`);
    return { ...KONFIGURASI_DEFAULT, ...(result.rows[0] ?? {}) };
  }

  /** Ubah sebagian konfigurasi (FR-ADM-05); dicatat `KONFIGURASI_SOS_UBAH` dengan nilai sebelum/sesudah. */
  async ubah(
    admin: AuthenticatedUser,
    perubahan: KonfigurasiSosUbah,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<KonfigurasiSos> {
    const kolom = KOLOM_UBAH.filter((key) => perubahan[key] !== undefined);
    if (kolom.length === 0) return this.ambil();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Pastikan baris singleton ada, lalu kunci agar nilai "sebelum" di audit akurat.
      await client.query(`INSERT INTO konfigurasi_sos (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      const before = await client.query<KonfigurasiSos>(
        `SELECT ${SELECT_KOLOM} FROM konfigurasi_sos WHERE id = 1 FOR UPDATE`,
      );
      const values = kolom.map((key) => perubahan[key]);
      const sets = kolom.map((key, index) => `${key} = $${index + 2}`);
      const after = await client.query<KonfigurasiSos>(
        `UPDATE konfigurasi_sos SET ${sets.join(', ')}, diubah_oleh = $1
         WHERE id = 1 RETURNING ${SELECT_KOLOM}`,
        [admin.id, ...values],
      );
      const sebelum = Object.fromEntries(kolom.map((key) => [key, before.rows[0]?.[key]]));
      const sesudah = Object.fromEntries(kolom.map((key) => [key, after.rows[0][key]]));
      await this.audit.catat({
        aktor: admin, aksi: 'KONFIGURASI_SOS_UBAH', resourceType: 'konfigurasi_sos', resourceId: '1',
        ip: ctx.ip, userAgent: ctx.userAgent, metadata: { sebelum, sesudah },
      }, client);
      await client.query('COMMIT');
      return { ...KONFIGURASI_DEFAULT, ...after.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
