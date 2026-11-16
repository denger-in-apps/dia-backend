import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { BuatSumberDayaDto, KategoriSumber, UbahSumberDayaDto } from './sumber-daya.dto';

export interface SumberDaya {
  id_sumber: string;
  nama: string;
  kategori: KategoriSumber;
  kontak: string;
  deskripsi: string | null;
  aktif: boolean;
  updated_at: Date;
}

type Ctx = { ip?: string; userAgent?: string };

const KOLOM = `id_sumber::text AS id_sumber, nama, kategori, kontak, deskripsi, aktif, updated_at`;

/** Urutan tampil: hotline nasional dulu (paling dibutuhkan saat darurat), lalu layanan kampus. */
const URUTAN = `CASE kategori WHEN 'HOTLINE_NASIONAL' THEN 0 WHEN 'UNIT_KESEHATAN_KAMPUS' THEN 1
  WHEN 'RUMAH_SAKIT_RUJUKAN' THEN 2 ELSE 3 END, nama`;

/**
 * Direktori sumber daya (PBI-19 / SCRUM-270; FR-MHS-10, FR-PSI-07, FR-ADM-03). Baca publik
 * (entri aktif saja); pengelolaan oleh Dosen Admin dengan audit `SUMBER_DAYA_*`.
 */
@Injectable()
export class SumberDayaService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async daftarPublik(kategori?: KategoriSumber): Promise<SumberDaya[]> {
    const result = await this.pool.query<SumberDaya>(
      `SELECT ${KOLOM} FROM sumber_daya
       WHERE aktif AND ($1::kategori_sumber IS NULL OR kategori = $1::kategori_sumber)
       ORDER BY ${URUTAN}`,
      [kategori ?? null],
    );
    return result.rows;
  }

  async detailPublik(id: string): Promise<SumberDaya> {
    const result = await this.pool.query<SumberDaya>(`SELECT ${KOLOM} FROM sumber_daya WHERE id_sumber = $1 AND aktif`, [id]);
    if (!result.rows[0]) throw this.tidakDitemukan();
    return result.rows[0];
  }

  /** Daftar admin termasuk entri nonaktif. */
  async daftarAdmin(kategori?: KategoriSumber): Promise<SumberDaya[]> {
    const result = await this.pool.query<SumberDaya>(
      `SELECT ${KOLOM} FROM sumber_daya
       WHERE ($1::kategori_sumber IS NULL OR kategori = $1::kategori_sumber)
       ORDER BY aktif DESC, ${URUTAN}`,
      [kategori ?? null],
    );
    return result.rows;
  }

  async buat(admin: AuthenticatedUser, dto: BuatSumberDayaDto, ctx: Ctx): Promise<SumberDaya> {
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query<SumberDaya>(
        `INSERT INTO sumber_daya (nama, kategori, kontak, deskripsi, aktif, id_dosen)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${KOLOM}`,
        [dto.nama, dto.kategori, dto.kontak, dto.deskripsi ?? null, dto.aktif ?? true, admin.id],
      );
      const row = result.rows[0];
      await this.catat(client, admin, 'SUMBER_DAYA_BUAT', row.id_sumber, ctx);
      return row;
    });
  }

  /** Ubah sebagian; `id_dosen` menjadi admin terakhir yang mengubah (penanggung jawab entri). */
  async ubah(admin: AuthenticatedUser, id: string, dto: UbahSumberDayaDto, ctx: Ctx): Promise<SumberDaya> {
    const kolom = (['nama', 'kategori', 'kontak', 'deskripsi', 'aktif'] as const).filter((key) => dto[key] !== undefined);
    return denganTransaksi(this.pool, async (client) => {
      const sets = [...kolom.map((key, i) => `${key} = $${i + 3}`), 'id_dosen = $2'];
      const result = await client.query<SumberDaya>(
        `UPDATE sumber_daya SET ${sets.join(', ')} WHERE id_sumber = $1 RETURNING ${KOLOM}`,
        [id, admin.id, ...kolom.map((key) => dto[key])],
      );
      if (!result.rows[0]) throw this.tidakDitemukan();
      await this.catat(client, admin, 'SUMBER_DAYA_UBAH', id, ctx, { field: kolom });
      return result.rows[0];
    });
  }

  async hapus(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<void> {
    await denganTransaksi(this.pool, async (client) => {
      const result = await client.query(`DELETE FROM sumber_daya WHERE id_sumber = $1`, [id]);
      if (result.rowCount !== 1) throw this.tidakDitemukan();
      await this.catat(client, admin, 'SUMBER_DAYA_HAPUS', id, ctx);
    });
  }

  private catat(client: PoolClient, admin: AuthenticatedUser, aksi: string, id: string, ctx: Ctx, metadata?: Record<string, unknown>) {
    return this.audit.catat({ aktor: admin, aksi, resourceType: 'sumber_daya', resourceId: id, ip: ctx.ip, userAgent: ctx.userAgent, metadata }, client);
  }

  private tidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'SUMBER_DAYA_TIDAK_DITEMUKAN', pesan: 'Sumber daya tidak ditemukan' });
  }
}
