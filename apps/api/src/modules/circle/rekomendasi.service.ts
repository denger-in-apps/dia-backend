import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { KandidatCircle, rekomendasikan } from './rekomendasi';

export const MAKS_PREFERENSI = 5;

/** Preferensi minat & rekomendasi Circle (PBI-18 / SCRUM-266, FR-MHS-07). */
@Injectable()
export class RekomendasiService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async preferensi(idMahasiswa: string) {
    const result = await this.pool.query<{ id: string; nama: string }>(
      `SELECT k.id_kategori::text AS id, k.nama
       FROM preferensi_minat p JOIN kategori_minat k ON k.id_kategori = p.id_kategori
       WHERE p.id_mahasiswa = $1 ORDER BY k.nama`,
      [idMahasiswa],
    );
    return result.rows;
  }

  /** Ganti seluruh preferensi (idempoten). Hanya kategori aktif; maks. 5. */
  async simpanPreferensi(idMahasiswa: string, idKategori: string[]) {
    const unik = [...new Set(idKategori)];
    if (unik.length > MAKS_PREFERENSI) {
      throw new UnprocessableEntityException({ kode: 'PREFERENSI_TERLALU_BANYAK', pesan: `Maksimal ${MAKS_PREFERENSI} kategori minat` });
    }
    await denganTransaksi(this.pool, async (client) => {
      if (unik.length) {
        const valid = await client.query<{ jumlah: number }>(
          `SELECT count(*)::int AS jumlah FROM kategori_minat WHERE id_kategori = ANY($1::uuid[]) AND aktif`,
          [unik],
        );
        if (valid.rows[0].jumlah !== unik.length) {
          throw new UnprocessableEntityException({ kode: 'KATEGORI_TIDAK_VALID', pesan: 'Ada kategori minat yang tidak ditemukan atau tidak aktif' });
        }
      }
      await client.query(`DELETE FROM preferensi_minat WHERE id_mahasiswa = $1`, [idMahasiswa]);
      if (unik.length) {
        await client.query(
          `INSERT INTO preferensi_minat (id_mahasiswa, id_kategori) SELECT $1, unnest($2::uuid[])`,
          [idMahasiswa, unik],
        );
      }
    });
    return this.preferensi(idMahasiswa);
  }

  /**
   * Rekomendasi Circle AKTIF yang belum diikuti dan belum penuh. Tanpa preferensi, urutan
   * memakai sisa kuota & aktivitas saja dan `butuh_preferensi: true` agar FE meminta minat.
   */
  async rekomendasi(idMahasiswa: string, limit = 5) {
    const [kandidat, pref] = await Promise.all([
      this.pool.query<KandidatCircle>(
        `SELECT c.id_circle::text AS id_circle, c.nama_circle, km.nama AS nama_kategori, c.kuota,
                (SELECT count(*)::int FROM keanggotaan_circle a WHERE a.id_circle = c.id_circle) AS jumlah_anggota,
                (SELECT count(*)::int FROM circle_pesan cp
                  WHERE cp.id_circle = c.id_circle AND NOT cp.disembunyikan AND cp.created_at > now() - interval '14 days') AS pesan_14_hari,
                EXISTS (SELECT 1 FROM preferensi_minat p WHERE p.id_mahasiswa = $1 AND p.id_kategori = c.id_kategori) AS minat_cocok
         FROM circle c JOIN kategori_minat km ON km.id_kategori = c.id_kategori
         WHERE c.status = 'AKTIF'
           AND NOT EXISTS (SELECT 1 FROM keanggotaan_circle k WHERE k.id_circle = c.id_circle AND k.id_mahasiswa = $1)
         LIMIT 200`,
        [idMahasiswa],
      ),
      this.pool.query<{ ada: boolean }>(`SELECT EXISTS (SELECT 1 FROM preferensi_minat WHERE id_mahasiswa = $1) AS ada`, [idMahasiswa]),
    ]);
    return {
      butuh_preferensi: !pref.rows[0]?.ada,
      rekomendasi: rekomendasikan(kandidat.rows, limit),
    };
  }
}
