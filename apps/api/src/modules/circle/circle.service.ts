import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AjukanCircleDto, TelusuriCircleQuery } from './circle.dto';
import { circleConfig, StatusCircle } from './circle.constants';
import { CirclePesanService, PesanCircle } from './circle-pesan.service';

export interface CircleRingkas {
  id_circle: string;
  nama_circle: string;
  deskripsi: string | null;
  kategori: { id: string; nama: string };
  kuota: number;
  jumlah_anggota: number;
  sisa_kuota: number;
  status: StatusCircle;
  nama_pendamping: string | null;
  sudah_bergabung: boolean;
}

export interface Keanggotaan {
  id_circle: string;
  alias_anonim: string;
  status_anonim: boolean;
  joined_at: Date;
}

export const KOLOM_CIRCLE = `c.id_circle::text AS id_circle, c.nama_circle, c.deskripsi, c.kuota, c.status,
  c.id_kategori::text AS id_kategori, km.nama AS nama_kategori, p.nama AS nama_pendamping,
  (SELECT count(*)::int FROM keanggotaan_circle a WHERE a.id_circle = c.id_circle) AS jumlah_anggota`;

export const FROM_CIRCLE = `FROM circle c
  JOIN kategori_minat km ON km.id_kategori = c.id_kategori
  LEFT JOIN psikolog p ON p.id_psikolog = c.id_psikolog`;

interface CircleRow {
  id_circle: string;
  nama_circle: string;
  deskripsi: string | null;
  kuota: number;
  status: StatusCircle;
  id_kategori: string;
  nama_kategori: string;
  nama_pendamping: string | null;
  jumlah_anggota: number;
  sudah_bergabung?: boolean;
}

export function toCircleRingkas(row: CircleRow): CircleRingkas {
  return {
    id_circle: row.id_circle,
    nama_circle: row.nama_circle,
    deskripsi: row.deskripsi,
    kategori: { id: row.id_kategori, nama: row.nama_kategori },
    kuota: row.kuota,
    jumlah_anggota: row.jumlah_anggota,
    sisa_kuota: Math.max(0, row.kuota - row.jumlah_anggota),
    status: row.status,
    nama_pendamping: row.nama_pendamping,
    sudah_bergabung: row.sudah_bergabung ?? false,
  };
}

export const circleTidakDitemukan = () =>
  new NotFoundException({ kode: 'CIRCLE_TIDAK_DITEMUKAN', pesan: 'Circle tidak ditemukan' });

/**
 * Circle — sisi mahasiswa (PBI-17 / SCRUM-263, FR-MHS-06): telusuri, bergabung (anonim
 * default, NFR-04), keluar, mengajukan pembentukan, dan ruang interaksi anggota.
 */
@Injectable()
export class CircleService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly pesan: CirclePesanService,
  ) {}

  async kategori() {
    const result = await this.pool.query<{ id: string; nama: string }>(
      `SELECT id_kategori::text AS id, nama FROM kategori_minat WHERE aktif ORDER BY nama`,
    );
    return result.rows;
  }

  async telusuri(idMahasiswa: string, query: TelusuriCircleQuery): Promise<CircleRingkas[]> {
    const q = query.q?.replace(/[%_\\]/g, (c) => `\\${c}`) ?? null;
    const result = await this.pool.query<CircleRow>(
      `SELECT ${KOLOM_CIRCLE},
              EXISTS (SELECT 1 FROM keanggotaan_circle a WHERE a.id_circle = c.id_circle AND a.id_mahasiswa = $1) AS sudah_bergabung
       ${FROM_CIRCLE}
       WHERE c.status = 'AKTIF'
         AND ($2::uuid IS NULL OR c.id_kategori = $2::uuid)
         AND ($3::text IS NULL OR c.nama_circle ILIKE '%' || $3 || '%' OR c.deskripsi ILIKE '%' || $3 || '%')
       ORDER BY c.nama_circle
       LIMIT $4`,
      [idMahasiswa, query.kategori ?? null, q, query.limit ?? 50],
    );
    return result.rows.map(toCircleRingkas);
  }

  /**
   * Detail Circle AKTIF (atau pengajuan milik sendiri). Daftar anggota (alias/nama) hanya
   * untuk anggota, agar keanggotaan tidak dapat diintip orang luar.
   */
  async detail(idMahasiswa: string, idCircle: string) {
    const result = await this.pool.query<CircleRow & { diajukan_oleh_saya: boolean; alasan_penolakan: string | null }>(
      `SELECT ${KOLOM_CIRCLE}, c.alasan_penolakan,
              EXISTS (SELECT 1 FROM keanggotaan_circle a WHERE a.id_circle = c.id_circle AND a.id_mahasiswa = $2) AS sudah_bergabung,
              COALESCE(c.diajukan_oleh = $2::uuid, false) AS diajukan_oleh_saya
       ${FROM_CIRCLE} WHERE c.id_circle = $1`,
      [idCircle, idMahasiswa],
    );
    const row = result.rows[0];
    if (!row || (row.status !== 'AKTIF' && !row.sudah_bergabung && !row.diajukan_oleh_saya)) throw circleTidakDitemukan();
    const anggota = row.sudah_bergabung ? await this.anggota(idCircle, idMahasiswa) : null;
    return {
      ...toCircleRingkas(row),
      alasan_penolakan: row.diajukan_oleh_saya ? row.alasan_penolakan : null,
      diajukan_oleh_saya: row.diajukan_oleh_saya,
      anggota,
    };
  }

  /** Bergabung secara atomik: baris `circle` dikunci sehingga kuota tidak terlewati (04-database.md §4.g). */
  async gabung(idMahasiswa: string, idCircle: string): Promise<Keanggotaan & { baru: boolean }> {
    return denganTransaksi(this.pool, async (client) => {
      const circle = await client.query<{ status: StatusCircle; kuota: number }>(
        `SELECT status, kuota FROM circle WHERE id_circle = $1 FOR UPDATE`,
        [idCircle],
      );
      if (!circle.rows[0]) throw circleTidakDitemukan();
      if (circle.rows[0].status !== 'AKTIF') {
        throw new ConflictException({ kode: 'CIRCLE_TIDAK_AKTIF', pesan: 'Circle tidak menerima anggota' });
      }
      const sudah = await this.keanggotaan(client, idMahasiswa, idCircle);
      if (sudah) return { ...sudah, baru: false };

      const jumlah = await client.query<{ anggota: number; diikuti: number }>(
        `SELECT (SELECT count(*)::int FROM keanggotaan_circle WHERE id_circle = $1) AS anggota,
                (SELECT count(*)::int FROM keanggotaan_circle k JOIN circle c ON c.id_circle = k.id_circle
                  WHERE k.id_mahasiswa = $2 AND c.status = 'AKTIF') AS diikuti`,
        [idCircle, idMahasiswa],
      );
      if (jumlah.rows[0].anggota >= circle.rows[0].kuota) {
        throw new ConflictException({ kode: 'CIRCLE_PENUH', pesan: 'Kuota Circle sudah penuh' });
      }
      if (jumlah.rows[0].diikuti >= circleConfig.maksKeanggotaan()) {
        throw new UnprocessableEntityException({
          kode: 'BATAS_KEANGGOTAAN',
          pesan: `Maksimal ${circleConfig.maksKeanggotaan()} Circle aktif yang diikuti`,
        });
      }
      const alias = await this.aliasUnik(client, idCircle);
      const inserted = await client.query<Keanggotaan>(
        `INSERT INTO keanggotaan_circle (id_mahasiswa, id_circle, alias_anonim) VALUES ($1, $2, $3)
         RETURNING id_circle::text AS id_circle, alias_anonim, status_anonim, joined_at`,
        [idMahasiswa, idCircle, alias],
      );
      return { ...inserted.rows[0], baru: true };
    });
  }

  /** Keluar Circle. Pesan anggota ikut terhapus (FK ON DELETE CASCADE) — jejak minimal. */
  async keluar(idMahasiswa: string, idCircle: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM keanggotaan_circle WHERE id_mahasiswa = $1 AND id_circle = $2`,
      [idMahasiswa, idCircle],
    );
    if (result.rowCount !== 1) throw this.bukanAnggota();
  }

  async ubahAnonim(idMahasiswa: string, idCircle: string, statusAnonim: boolean): Promise<Keanggotaan> {
    const result = await this.pool.query<Keanggotaan>(
      `UPDATE keanggotaan_circle SET status_anonim = $3 WHERE id_mahasiswa = $1 AND id_circle = $2
       RETURNING id_circle::text AS id_circle, alias_anonim, status_anonim, joined_at`,
      [idMahasiswa, idCircle, statusAnonim],
    );
    if (!result.rows[0]) throw this.bukanAnggota();
    return result.rows[0];
  }

  /** Ajukan pembentukan Circle (status DIAJUKAN, menunggu persetujuan Dosen Admin — SCRUM-264). */
  async ajukan(idMahasiswa: string, dto: AjukanCircleDto) {
    return denganTransaksi(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`circle-ajukan:${idMahasiswa}`]);
      const kategori = await client.query(`SELECT 1 FROM kategori_minat WHERE id_kategori = $1 AND aktif`, [dto.id_kategori]);
      if (!kategori.rowCount) {
        throw new UnprocessableEntityException({ kode: 'KATEGORI_TIDAK_VALID', pesan: 'Kategori minat tidak ditemukan atau tidak aktif' });
      }
      const pending = await client.query<{ jumlah: number }>(
        `SELECT count(*)::int AS jumlah FROM circle WHERE diajukan_oleh = $1 AND status = 'DIAJUKAN'`,
        [idMahasiswa],
      );
      if (pending.rows[0].jumlah >= circleConfig.maksPengajuan()) {
        throw new UnprocessableEntityException({
          kode: 'BATAS_PENGAJUAN',
          pesan: `Maksimal ${circleConfig.maksPengajuan()} pengajuan Circle yang menunggu persetujuan`,
        });
      }
      const result = await client.query<{ id_circle: string; status: StatusCircle; created_at: Date }>(
        `INSERT INTO circle (nama_circle, deskripsi, id_kategori, kuota, status, diajukan_oleh)
         VALUES ($1, $2, $3, $4, 'DIAJUKAN', $5)
         RETURNING id_circle::text AS id_circle, status, created_at`,
        [dto.nama_circle, dto.deskripsi ?? null, dto.id_kategori, dto.kuota ?? 8, idMahasiswa],
      );
      return result.rows[0];
    });
  }

  /** Circle yang diikuti + pengajuan milik sendiri. */
  async saya(idMahasiswa: string) {
    const [diikuti, pengajuan] = await Promise.all([
      this.pool.query<CircleRow & { alias_anonim: string; status_anonim: boolean }>(
        `SELECT ${KOLOM_CIRCLE}, true AS sudah_bergabung, k.alias_anonim, k.status_anonim
         ${FROM_CIRCLE} JOIN keanggotaan_circle k ON k.id_circle = c.id_circle AND k.id_mahasiswa = $1
         ORDER BY k.joined_at DESC`,
        [idMahasiswa],
      ),
      this.pool.query<CircleRow & { alasan_penolakan: string | null }>(
        `SELECT ${KOLOM_CIRCLE}, c.alasan_penolakan ${FROM_CIRCLE}
         WHERE c.diajukan_oleh = $1 AND c.status IN ('DIAJUKAN', 'DITOLAK') ORDER BY c.created_at DESC`,
        [idMahasiswa],
      ),
    ]);
    return {
      diikuti: diikuti.rows.map((row) => ({
        ...toCircleRingkas(row), keanggotaan: { alias_anonim: row.alias_anonim, status_anonim: row.status_anonim },
      })),
      pengajuan: pengajuan.rows.map((row) => ({ ...toCircleRingkas(row), alasan_penolakan: row.alasan_penolakan })),
    };
  }

  async daftarPesan(idMahasiswa: string, idCircle: string, sebelum?: string, limit?: number): Promise<PesanCircle[]> {
    if (!(await this.keanggotaan(this.pool, idMahasiswa, idCircle))) throw this.bukanAnggota();
    return this.pesan.daftar(idCircle, { tipe: 'MAHASISWA', id: idMahasiswa }, sebelum, limit);
  }

  async kirimPesan(idMahasiswa: string, idCircle: string, isi: string): Promise<{ id_pesan: string }> {
    const id = await denganTransaksi(this.pool, async (client) => {
      const status = await client.query<{ status: StatusCircle }>(
        `SELECT c.status FROM circle c JOIN keanggotaan_circle k ON k.id_circle = c.id_circle AND k.id_mahasiswa = $2
         WHERE c.id_circle = $1`,
        [idCircle, idMahasiswa],
      );
      if (!status.rows[0]) throw this.bukanAnggota();
      if (status.rows[0].status !== 'AKTIF') {
        throw new ConflictException({ kode: 'CIRCLE_TIDAK_AKTIF', pesan: 'Circle sudah ditutup' });
      }
      return this.pesan.kirim(client, idCircle, { tipe: 'MAHASISWA', id: idMahasiswa }, isi);
    });
    return { id_pesan: id };
  }

  // ---------------------------------------------------------------------------

  private async anggota(idCircle: string, idMahasiswa: string) {
    const result = await this.pool.query<{ nama: string; anonim: boolean; saya: boolean }>(
      `SELECT CASE WHEN k.status_anonim THEN k.alias_anonim ELSE COALESCE(m.nama_tampilan, m.nama) END AS nama,
              k.status_anonim AS anonim, (k.id_mahasiswa = $2::uuid) AS saya
       FROM keanggotaan_circle k JOIN mahasiswa m ON m.id_mahasiswa = k.id_mahasiswa
       WHERE k.id_circle = $1 ORDER BY k.joined_at`,
      [idCircle, idMahasiswa],
    );
    return result.rows;
  }

  private async keanggotaan(executor: Pool | PoolClient, idMahasiswa: string, idCircle: string): Promise<Keanggotaan | null> {
    const result = await executor.query<Keanggotaan>(
      `SELECT id_circle::text AS id_circle, alias_anonim, status_anonim, joined_at
       FROM keanggotaan_circle WHERE id_mahasiswa = $1 AND id_circle = $2`,
      [idMahasiswa, idCircle],
    );
    return result.rows[0] ?? null;
  }

  /** `Anggota-XXXX` acak, unik dalam Circle (dijamin juga oleh UNIQUE (id_circle, alias_anonim)). */
  private async aliasUnik(client: PoolClient, idCircle: string): Promise<string> {
    const terpakai = await client.query<{ alias_anonim: string }>(
      `SELECT alias_anonim FROM keanggotaan_circle WHERE id_circle = $1`,
      [idCircle],
    );
    const set = new Set(terpakai.rows.map((r) => r.alias_anonim));
    for (;;) {
      const alias = `Anggota-${randomBytes(2).toString('hex').toUpperCase()}`;
      if (!set.has(alias)) return alias;
    }
  }

  private bukanAnggota(): ForbiddenException {
    return new ForbiddenException({ kode: 'BUKAN_ANGGOTA', pesan: 'Anda bukan anggota Circle ini' });
  }
}
