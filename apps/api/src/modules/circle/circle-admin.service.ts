import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { BuatCircleAdminDto, DaftarCircleAdminQuery, UbahCircleAdminDto, UbahKategoriMinatDto } from './circle-admin.dto';
import { StatusCircle } from './circle.constants';
import { circleTidakDitemukan, FROM_CIRCLE, KOLOM_CIRCLE, toCircleRingkas } from './circle.service';

type Ctx = { ip?: string; userAgent?: string };
const UNIQUE_VIOLATION = '23505';

interface AdminRow {
  id_circle: string;
  nama_circle: string;
  deskripsi: string | null;
  kuota: number;
  status: StatusCircle;
  id_kategori: string;
  nama_kategori: string;
  nama_pendamping: string | null;
  jumlah_anggota: number;
  id_psikolog: string | null;
  alasan_penolakan: string | null;
  diajukan_mahasiswa: boolean;
  created_at: Date;
}

/**
 * Persetujuan & pengelolaan Circle oleh Dosen Admin (PBI-17 / SCRUM-264, FR-ADM-07).
 * Admin tidak melihat identitas anggota/pengaju maupun isi pesan (04-database.md §4.e):
 * hanya metadata dan jumlah anggota. Semua aksi diaudit `CIRCLE_*`.
 */
@Injectable()
export class CircleAdminService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async daftar(query: DaftarCircleAdminQuery) {
    const result = await this.pool.query<AdminRow>(
      `SELECT ${KOLOM_CIRCLE}, c.id_psikolog::text AS id_psikolog, c.alasan_penolakan,
              (c.diajukan_oleh IS NOT NULL) AS diajukan_mahasiswa, c.created_at
       ${FROM_CIRCLE}
       WHERE ($1::status_circle IS NULL OR c.status = $1::status_circle)
       ORDER BY c.status, c.created_at`,
      [query.status ?? null],
    );
    return result.rows.map((row) => this.toDto(row));
  }

  async detail(idCircle: string) {
    return this.toDto(await this.ambil(this.pool, idCircle));
  }

  /** DIAJUKAN → AKTIF dengan psikolog pendamping; pengaju dikabari `CIRCLE_DISETUJUI`. */
  async setujui(admin: AuthenticatedUser, idCircle: string, idPsikolog: string, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      await this.pastikanPsikologAktif(client, idPsikolog);
      const result = await client.query<{ diajukan_oleh: string | null; nama_circle: string }>(
        `UPDATE circle SET status = 'AKTIF', id_psikolog = $2, id_dosen = $3, alasan_penolakan = NULL
         WHERE id_circle = $1 AND status = 'DIAJUKAN'
         RETURNING diajukan_oleh::text AS diajukan_oleh, nama_circle`,
        [idCircle, idPsikolog, admin.id],
      );
      if (!result.rows[0]) throw await this.alasanStatus(client, idCircle, 'disetujui');
      await this.kabariPengaju(client, result.rows[0].diajukan_oleh, 'CIRCLE_DISETUJUI', { id_circle: idCircle, nama_circle: result.rows[0].nama_circle });
      await this.catat(client, admin, 'CIRCLE_SETUJUI', idCircle, ctx, { id_psikolog: idPsikolog });
      return this.toDto(await this.ambil(client, idCircle));
    });
  }

  /** DIAJUKAN → DITOLAK dengan alasan (terlihat oleh pengaju); pengaju dikabari `CIRCLE_DITOLAK`. */
  async tolak(admin: AuthenticatedUser, idCircle: string, alasan: string, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query<{ diajukan_oleh: string | null; nama_circle: string }>(
        `UPDATE circle SET status = 'DITOLAK', alasan_penolakan = $2, id_dosen = $3
         WHERE id_circle = $1 AND status = 'DIAJUKAN'
         RETURNING diajukan_oleh::text AS diajukan_oleh, nama_circle`,
        [idCircle, alasan, admin.id],
      );
      if (!result.rows[0]) throw await this.alasanStatus(client, idCircle, 'ditolak');
      await this.kabariPengaju(client, result.rows[0].diajukan_oleh, 'CIRCLE_DITOLAK', { id_circle: idCircle, nama_circle: result.rows[0].nama_circle });
      await this.catat(client, admin, 'CIRCLE_TOLAK', idCircle, ctx);
      return this.toDto(await this.ambil(client, idCircle));
    });
  }

  /** Admin membuat Circle langsung AKTIF (mis. Circle resmi kampus). */
  async buat(admin: AuthenticatedUser, dto: BuatCircleAdminDto, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      await this.pastikanKategoriAktif(client, dto.id_kategori);
      await this.pastikanPsikologAktif(client, dto.id_psikolog);
      const result = await client.query<{ id_circle: string }>(
        `INSERT INTO circle (nama_circle, deskripsi, id_kategori, kuota, status, id_psikolog, id_dosen)
         VALUES ($1, $2, $3, $4, 'AKTIF', $5, $6) RETURNING id_circle::text AS id_circle`,
        [dto.nama_circle, dto.deskripsi ?? null, dto.id_kategori, dto.kuota ?? 8, dto.id_psikolog, admin.id],
      );
      const id = result.rows[0].id_circle;
      await this.catat(client, admin, 'CIRCLE_BUAT', id, ctx);
      return this.toDto(await this.ambil(client, id));
    });
  }

  /** Ubah sebagian. Kuota tidak boleh di bawah jumlah anggota; pendamping hanya untuk Circle AKTIF. */
  async ubah(admin: AuthenticatedUser, idCircle: string, dto: UbahCircleAdminDto, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const current = await this.ambil(client, idCircle, true);
      if (current.status === 'DITOLAK' || current.status === 'DITUTUP') {
        throw new ConflictException({ kode: 'CIRCLE_TIDAK_DAPAT_DIUBAH', pesan: `Circle berstatus ${current.status} tidak dapat diubah` });
      }
      if (dto.kuota !== undefined && dto.kuota < current.jumlah_anggota) {
        throw new ConflictException({
          kode: 'KUOTA_DI_BAWAH_ANGGOTA',
          pesan: `Kuota tidak boleh kurang dari jumlah anggota saat ini (${current.jumlah_anggota})`,
        });
      }
      if (dto.id_psikolog !== undefined) {
        if (current.status !== 'AKTIF') {
          throw new UnprocessableEntityException({ kode: 'PENDAMPING_LEWAT_PERSETUJUAN', pesan: 'Pendamping ditetapkan saat menyetujui Circle' });
        }
        await this.pastikanPsikologAktif(client, dto.id_psikolog);
      }
      if (dto.id_kategori !== undefined) await this.pastikanKategoriAktif(client, dto.id_kategori);

      const kolom = (['nama_circle', 'deskripsi', 'id_kategori', 'kuota', 'id_psikolog'] as const)
        .filter((key) => dto[key] !== undefined);
      if (kolom.length) {
        await client.query(
          `UPDATE circle SET ${kolom.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id_circle = $1`,
          [idCircle, ...kolom.map((key) => dto[key])],
        );
        await this.catat(client, admin, 'CIRCLE_UBAH', idCircle, ctx, { field: kolom });
      }
      return this.toDto(await this.ambil(client, idCircle));
    });
  }

  /** AKTIF/DIAJUKAN → DITUTUP. Anggota & riwayat pesan tetap tersimpan, tetapi tidak dapat menulis lagi. */
  async tutup(admin: AuthenticatedUser, idCircle: string, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE circle SET status = 'DITUTUP' WHERE id_circle = $1 AND status IN ('AKTIF', 'DIAJUKAN') RETURNING 1`,
        [idCircle],
      );
      if (!result.rowCount) throw await this.alasanStatus(client, idCircle, 'ditutup');
      await this.catat(client, admin, 'CIRCLE_TUTUP', idCircle, ctx);
      return this.toDto(await this.ambil(client, idCircle));
    });
  }

  // ---- Kategori minat (master data Circle, FR-ADM-07) --------------------------------

  async daftarKategori() {
    const result = await this.pool.query(
      `SELECT k.id_kategori::text AS id, k.nama, k.aktif,
              (SELECT count(*)::int FROM circle c WHERE c.id_kategori = k.id_kategori AND c.status = 'AKTIF') AS circle_aktif
       FROM kategori_minat k ORDER BY k.aktif DESC, k.nama`,
    );
    return result.rows;
  }

  async buatKategori(admin: AuthenticatedUser, nama: string, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const result = await this.tulisKategori(() => client.query<{ id: string; nama: string; aktif: boolean }>(
        `INSERT INTO kategori_minat (nama) VALUES ($1) RETURNING id_kategori::text AS id, nama, aktif`,
        [nama],
      ));
      await this.catat(client, admin, 'KATEGORI_MINAT_BUAT', result.id, ctx, undefined, 'kategori_minat');
      return result;
    });
  }

  /** Nonaktifkan = sembunyikan dari pilihan baru; Circle yang sudah ada tidak terpengaruh. */
  async ubahKategori(admin: AuthenticatedUser, id: string, dto: UbahKategoriMinatDto, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const result = await this.tulisKategori(() => client.query<{ id: string; nama: string; aktif: boolean }>(
        `UPDATE kategori_minat SET nama = COALESCE($2, nama), aktif = COALESCE($3, aktif)
         WHERE id_kategori = $1 RETURNING id_kategori::text AS id, nama, aktif`,
        [id, dto.nama ?? null, dto.aktif ?? null],
      ));
      await this.catat(client, admin, 'KATEGORI_MINAT_UBAH', id, ctx, { field: Object.keys(dto) }, 'kategori_minat');
      return result;
    });
  }

  // ---------------------------------------------------------------------------

  private async ambil(executor: Pool | PoolClient, idCircle: string, lock = false): Promise<AdminRow> {
    const result = await executor.query<AdminRow>(
      `SELECT ${KOLOM_CIRCLE}, c.id_psikolog::text AS id_psikolog, c.alasan_penolakan,
              (c.diajukan_oleh IS NOT NULL) AS diajukan_mahasiswa, c.created_at
       ${FROM_CIRCLE} WHERE c.id_circle = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [idCircle],
    );
    if (!result.rows[0]) throw circleTidakDitemukan();
    return result.rows[0];
  }

  private async alasanStatus(client: PoolClient, idCircle: string, aksi: string): Promise<Error> {
    const result = await client.query<{ status: StatusCircle }>(`SELECT status FROM circle WHERE id_circle = $1`, [idCircle]);
    if (!result.rows[0]) return circleTidakDitemukan();
    return new ConflictException({
      kode: 'STATUS_CIRCLE_TIDAK_SESUAI',
      pesan: `Circle berstatus ${result.rows[0].status} tidak dapat ${aksi}`,
    });
  }

  private async pastikanPsikologAktif(client: PoolClient, idPsikolog: string) {
    const result = await client.query(`SELECT 1 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`, [idPsikolog]);
    if (!result.rowCount) {
      throw new UnprocessableEntityException({ kode: 'PSIKOLOG_TIDAK_AKTIF', pesan: 'Pendamping harus psikolog berstatus AKTIF' });
    }
  }

  private async pastikanKategoriAktif(client: PoolClient, idKategori: string) {
    const result = await client.query(`SELECT 1 FROM kategori_minat WHERE id_kategori = $1 AND aktif`, [idKategori]);
    if (!result.rowCount) {
      throw new UnprocessableEntityException({ kode: 'KATEGORI_TIDAK_VALID', pesan: 'Kategori minat tidak ditemukan atau tidak aktif' });
    }
  }

  private async kabariPengaju(
    client: PoolClient,
    idMahasiswa: string | null,
    jenis: 'CIRCLE_DISETUJUI' | 'CIRCLE_DITOLAK',
    payload: Record<string, unknown>,
  ) {
    if (!idMahasiswa) return; // Circle dibuat admin, tanpa pengaju mahasiswa.
    await client.query(
      `INSERT INTO notifikasi (id_penerima, role, jenis, payload) VALUES ($1, 'MAHASISWA', $2, $3::jsonb)`,
      [idMahasiswa, jenis, JSON.stringify(payload)],
    );
  }

  private async tulisKategori<T>(query: () => Promise<{ rows: T[] }>): Promise<T> {
    try {
      const result = await query();
      if (!result.rows[0]) throw new NotFoundException({ kode: 'KATEGORI_TIDAK_DITEMUKAN', pesan: 'Kategori minat tidak ditemukan' });
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException({ kode: 'KATEGORI_SUDAH_ADA', pesan: 'Nama kategori sudah dipakai' });
      }
      throw error;
    }
  }

  private catat(
    client: PoolClient,
    admin: AuthenticatedUser,
    aksi: string,
    id: string,
    ctx: Ctx,
    metadata?: Record<string, unknown>,
    resourceType = 'circle',
  ) {
    return this.audit.catat({ aktor: admin, aksi, resourceType, resourceId: id, ip: ctx.ip, userAgent: ctx.userAgent, metadata }, client);
  }

  private toDto(row: AdminRow) {
    return {
      ...toCircleRingkas(row),
      id_psikolog: row.id_psikolog,
      alasan_penolakan: row.alasan_penolakan,
      diajukan_mahasiswa: row.diajukan_mahasiswa,
      created_at: row.created_at,
    };
  }
}
