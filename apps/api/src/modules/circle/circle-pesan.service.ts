import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { circleConfig, SQL_NAMA_PENGIRIM } from './circle.constants';

export interface PesanCircle {
  id_pesan: string;
  created_at: Date;
  pengirim: { tipe: 'ANGGOTA' | 'PENDAMPING'; nama: string; milik_saya: boolean };
  /** `null` bila disembunyikan moderator (kecuali dilihat pendamping). */
  isi: string | null;
  disembunyikan: boolean;
  alasan_moderasi: string | null;
}

export interface Pembaca {
  /** Mahasiswa anggota atau psikolog pendamping. */
  tipe: 'MAHASISWA' | 'PSIKOLOG';
  id: string;
}

interface PesanRow {
  id_pesan: string;
  created_at: Date;
  nama_pengirim: string;
  dari_psikolog: boolean;
  milik_saya: boolean;
  isi: string;
  disembunyikan: boolean;
  alasan_moderasi: string | null;
}

/**
 * Ruang interaksi Circle (`circle_pesan`; ASUMSI skema 04-database.md). Dipakai anggota
 * (SCRUM-263) dan psikolog pendamping (SCRUM-267). Pemeriksaan hak akses dilakukan pemanggil.
 */
@Injectable()
export class CirclePesanService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async daftar(idCircle: string, pembaca: Pembaca, sebelum?: string, limit = 50): Promise<PesanCircle[]> {
    const result = await this.pool.query<PesanRow>(
      `SELECT cp.id_pesan::text AS id_pesan, cp.created_at, ${SQL_NAMA_PENGIRIM} AS nama_pengirim,
              (cp.id_psikolog IS NOT NULL) AS dari_psikolog,
              COALESCE(CASE WHEN $3::text = 'MAHASISWA' THEN cp.id_mahasiswa = $2::uuid ELSE cp.id_psikolog = $2::uuid END, false) AS milik_saya,
              cp.isi, cp.disembunyikan, cp.alasan_moderasi
       FROM circle_pesan cp
       LEFT JOIN keanggotaan_circle k ON k.id_mahasiswa = cp.id_mahasiswa AND k.id_circle = cp.id_circle
       LEFT JOIN mahasiswa m ON m.id_mahasiswa = cp.id_mahasiswa
       LEFT JOIN psikolog p ON p.id_psikolog = cp.id_psikolog
       WHERE cp.id_circle = $1
         AND ($4::uuid IS NULL OR cp.created_at < (SELECT created_at FROM circle_pesan WHERE id_pesan = $4::uuid))
       ORDER BY cp.created_at DESC, cp.id_pesan DESC
       LIMIT $5`,
      [idCircle, pembaca.id, pembaca.tipe, sebelum ?? null, limit],
    );
    // Urut naik untuk tampilan chat; paginasi tetap mundur lewat `sebelum`.
    return result.rows.reverse().map((row) => ({
      id_pesan: row.id_pesan,
      created_at: row.created_at,
      pengirim: { tipe: row.dari_psikolog ? 'PENDAMPING' : 'ANGGOTA', nama: row.nama_pengirim, milik_saya: row.milik_saya },
      // Anggota tidak melihat isi yang disembunyikan; pendamping tetap melihatnya untuk peninjauan.
      isi: row.disembunyikan && pembaca.tipe === 'MAHASISWA' ? null : row.isi,
      disembunyikan: row.disembunyikan,
      alasan_moderasi: row.alasan_moderasi,
    }));
  }

  /** Simpan pesan (pemanggil sudah memastikan hak & status Circle AKTIF dalam `client`). */
  async kirim(client: PoolClient, idCircle: string, pengirim: Pembaca, isi: string): Promise<string> {
    const kolom = pengirim.tipe === 'MAHASISWA' ? 'id_mahasiswa' : 'id_psikolog';
    const count = await client.query<{ jumlah: number }>(
      `SELECT count(*)::int AS jumlah FROM circle_pesan
       WHERE id_circle = $1 AND ${kolom} = $2 AND created_at > now() - interval '1 minute'`,
      [idCircle, pengirim.id],
    );
    if (count.rows[0].jumlah >= circleConfig.maksPesanPerMenit()) {
      throw new HttpException({ kode: 'PESAN_TERLALU_CEPAT', pesan: 'Terlalu banyak pesan, tunggu sebentar' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = await client.query<{ id_pesan: string }>(
      `INSERT INTO circle_pesan (id_circle, ${kolom}, isi) VALUES ($1, $2, $3) RETURNING id_pesan::text AS id_pesan`,
      [idCircle, pengirim.id, isi],
    );
    return result.rows[0].id_pesan;
  }
}
