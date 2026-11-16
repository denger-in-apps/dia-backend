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
import { JUMLAH_BUTIR } from '../cek-mandiri/skor';
import { BuatTemplateDto, UbahKategoriMinatDto } from './master-data.dto';

type Ctx = { ip?: string; userAgent?: string };
const UNIQUE_VIOLATION = '23505';

export interface KategoriMinat {
  id: string;
  nama: string;
  aktif: boolean;
}

const KOLOM_TEMPLATE = `t.id_template::text AS id_template, t.kode, t.nama, t.versi, t.aktif, t.created_at,
  jsonb_array_length(t.butir->'butir') AS jumlah_butir, d.nama AS dibuat_oleh,
  (SELECT count(*)::int FROM hasil_cek_mandiri h
    WHERE h.id_template_phq9 = t.id_template OR h.id_template_gad7 = t.id_template) AS jumlah_dipakai`;

/**
 * Master data oleh Dosen Admin (PBI-20 / SCRUM-275, FR-ADM-07): kategori minat (dipakai Circle
 * dan rekomendasi) dan template kuesioner cek mandiri berversi. Semua perubahan diaudit.
 */
@Injectable()
export class MasterDataService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  // ---- Kategori minat -------------------------------------------------------

  async daftarKategori() {
    const result = await this.pool.query(
      `SELECT k.id_kategori::text AS id, k.nama, k.aktif,
              (SELECT count(*)::int FROM circle c WHERE c.id_kategori = k.id_kategori AND c.status = 'AKTIF') AS circle_aktif,
              (SELECT count(*)::int FROM circle c WHERE c.id_kategori = k.id_kategori) AS circle_total
       FROM kategori_minat k ORDER BY k.aktif DESC, k.nama`,
    );
    return result.rows;
  }

  async buatKategori(admin: AuthenticatedUser, nama: string, ctx: Ctx): Promise<KategoriMinat> {
    return denganTransaksi(this.pool, async (client) => {
      const result = await this.tulisKategori(() => client.query<KategoriMinat>(
        `INSERT INTO kategori_minat (nama) VALUES ($1) RETURNING id_kategori::text AS id, nama, aktif`,
        [nama],
      ));
      await this.catat(client, admin, 'KATEGORI_MINAT_BUAT', 'kategori_minat', result.id, ctx);
      return result;
    });
  }

  /** Nonaktifkan = sembunyikan dari pilihan baru; Circle yang sudah ada tidak terpengaruh. */
  async ubahKategori(admin: AuthenticatedUser, id: string, dto: UbahKategoriMinatDto, ctx: Ctx): Promise<KategoriMinat> {
    return denganTransaksi(this.pool, async (client) => {
      const result = await this.tulisKategori(() => client.query<KategoriMinat>(
        `UPDATE kategori_minat SET nama = COALESCE($2, nama), aktif = COALESCE($3, aktif)
         WHERE id_kategori = $1 RETURNING id_kategori::text AS id, nama, aktif`,
        [id, dto.nama ?? null, dto.aktif ?? null],
      ));
      await this.catat(client, admin, 'KATEGORI_MINAT_UBAH', 'kategori_minat', id, ctx, { field: Object.keys(dto) });
      return result;
    });
  }

  /** Hapus hanya kategori yang tidak pernah dipakai Circle; preferensi mahasiswa ikut dihapus. */
  async hapusKategori(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<void> {
    await denganTransaksi(this.pool, async (client) => {
      const kunci = await client.query(`SELECT 1 FROM kategori_minat WHERE id_kategori = $1 FOR UPDATE`, [id]);
      if (!kunci.rowCount) throw this.kategoriTidakDitemukan();
      const dipakai = await client.query<{ jumlah: number }>(`SELECT count(*)::int AS jumlah FROM circle WHERE id_kategori = $1`, [id]);
      if (dipakai.rows[0].jumlah > 0) {
        throw new ConflictException({
          kode: 'KATEGORI_DIPAKAI',
          pesan: `Kategori dipakai ${dipakai.rows[0].jumlah} Circle; nonaktifkan saja (aktif: false)`,
        });
      }
      const pref = await client.query(`DELETE FROM preferensi_minat WHERE id_kategori = $1`, [id]);
      await client.query(`DELETE FROM kategori_minat WHERE id_kategori = $1`, [id]);
      await this.catat(client, admin, 'KATEGORI_MINAT_HAPUS', 'kategori_minat', id, ctx, { preferensi_dihapus: pref.rowCount ?? 0 });
    });
  }

  // ---- Template kuesioner ---------------------------------------------------

  async daftarTemplate(kode?: string) {
    const result = await this.pool.query(
      `SELECT ${KOLOM_TEMPLATE}
       FROM template_kuesioner t LEFT JOIN dosen_admin d ON d.id_dosen = t.created_by
       WHERE ($1::text IS NULL OR t.kode = $1) ORDER BY t.kode, t.versi DESC`,
      [kode ?? null],
    );
    return result.rows;
  }

  async detailTemplate(id: string) {
    const result = await this.pool.query(
      `SELECT ${KOLOM_TEMPLATE}, t.butir
       FROM template_kuesioner t LEFT JOIN dosen_admin d ON d.id_dosen = t.created_by
       WHERE t.id_template = $1`,
      [id],
    );
    if (!result.rows[0]) throw this.templateTidakDitemukan();
    return result.rows[0];
  }

  /**
   * Buat versi baru (nonaktif). Isi divalidasi agar skor tetap sahih: jumlah butir standar
   * (PHQ-9 = 9, GAD-7 = 7) bernomor 1..n, dan tepat 4 opsi bernilai 0..3.
   */
  async buatTemplate(admin: AuthenticatedUser, dto: BuatTemplateDto, ctx: Ctx) {
    this.validasiIsi(dto);
    return denganTransaksi(this.pool, async (client) => {
      // Serialisasi per kode agar nomor versi tidak bentrok saat dibuat bersamaan.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`template:${dto.kode}`]);
      const result = await client.query<{ id_template: string; versi: number }>(
        `INSERT INTO template_kuesioner (kode, nama, versi, butir, aktif, created_by)
         SELECT $1, $2, COALESCE(max(versi), 0) + 1, $3::jsonb, false, $4 FROM template_kuesioner WHERE kode = $1
         RETURNING id_template::text AS id_template, versi`,
        [dto.kode, dto.nama, JSON.stringify(dto.butir), admin.id],
      );
      const { id_template, versi } = result.rows[0];
      await this.catat(client, admin, 'TEMPLATE_KUESIONER_BUAT', 'template_kuesioner', id_template, ctx, { kode: dto.kode, versi });
      return { id_template, kode: dto.kode, versi, aktif: false };
    });
  }

  /**
   * Jadikan versi ini satu-satunya yang aktif untuk kodenya (indeks unik parsial
   * `uq_template_kuesioner_aktif`). Hasil lama tetap merujuk template yang dipakainya.
   */
  async aktifkanTemplate(admin: AuthenticatedUser, id: string, ctx: Ctx) {
    return denganTransaksi(this.pool, async (client) => {
      const template = await this.kunciTemplate(client, id);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`template:${template.kode}`]);
      const sebelum = await client.query<{ id_template: string }>(
        `UPDATE template_kuesioner SET aktif = false WHERE kode = $1 AND aktif AND id_template <> $2
         RETURNING id_template::text AS id_template`,
        [template.kode, id],
      );
      await client.query(`UPDATE template_kuesioner SET aktif = true WHERE id_template = $1`, [id]);
      await this.catat(client, admin, 'TEMPLATE_KUESIONER_AKTIFKAN', 'template_kuesioner', id, ctx, {
        kode: template.kode, versi: template.versi, menggantikan: sebelum.rows.map((r) => r.id_template),
      });
      return { id_template: id, kode: template.kode, versi: template.versi, aktif: true };
    });
  }

  /** Hapus hanya versi yang tidak aktif dan belum pernah dipakai hasil cek mandiri. */
  async hapusTemplate(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<void> {
    await denganTransaksi(this.pool, async (client) => {
      const template = await this.kunciTemplate(client, id);
      if (template.aktif) {
        throw new ConflictException({ kode: 'TEMPLATE_AKTIF', pesan: 'Aktifkan versi lain sebelum menghapus versi yang aktif' });
      }
      const dipakai = await client.query<{ jumlah: number }>(
        `SELECT count(*)::int AS jumlah FROM hasil_cek_mandiri WHERE id_template_phq9 = $1 OR id_template_gad7 = $1`,
        [id],
      );
      if (dipakai.rows[0].jumlah > 0) {
        throw new ConflictException({ kode: 'TEMPLATE_DIPAKAI', pesan: 'Template sudah dipakai hasil cek mandiri dan harus disimpan' });
      }
      await client.query(`DELETE FROM template_kuesioner WHERE id_template = $1`, [id]);
      await this.catat(client, admin, 'TEMPLATE_KUESIONER_HAPUS', 'template_kuesioner', id, ctx, { kode: template.kode, versi: template.versi });
    });
  }

  // ---------------------------------------------------------------------------

  private validasiIsi(dto: BuatTemplateDto): void {
    const jumlah = JUMLAH_BUTIR[dto.kode];
    const nomor = dto.butir.butir.map((b) => b.no);
    if (dto.butir.butir.length !== jumlah || nomor.some((no, i) => no !== i + 1)) {
      throw new UnprocessableEntityException({
        kode: 'BUTIR_TIDAK_VALID',
        pesan: `${dto.kode} harus berisi tepat ${jumlah} butir bernomor 1..${jumlah} berurutan`,
      });
    }
    const nilai = dto.butir.opsi.map((o) => o.nilai).sort();
    if (nilai.join(',') !== '0,1,2,3') {
      throw new UnprocessableEntityException({ kode: 'OPSI_TIDAK_VALID', pesan: 'Opsi harus tepat bernilai 0, 1, 2, dan 3' });
    }
  }

  private async kunciTemplate(client: PoolClient, id: string) {
    const result = await client.query<{ kode: string; versi: number; aktif: boolean }>(
      `SELECT kode, versi, aktif FROM template_kuesioner WHERE id_template = $1 FOR UPDATE`,
      [id],
    );
    if (!result.rows[0]) throw this.templateTidakDitemukan();
    return result.rows[0];
  }

  private async tulisKategori<T>(query: () => Promise<{ rows: T[] }>): Promise<T> {
    try {
      const result = await query();
      if (!result.rows[0]) throw this.kategoriTidakDitemukan();
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
    resourceType: string,
    id: string,
    ctx: Ctx,
    metadata?: Record<string, unknown>,
  ) {
    return this.audit.catat({ aktor: admin, aksi, resourceType, resourceId: id, ip: ctx.ip, userAgent: ctx.userAgent, metadata }, client);
  }

  private kategoriTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'KATEGORI_TIDAK_DITEMUKAN', pesan: 'Kategori minat tidak ditemukan' });
  }

  private templateTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'TEMPLATE_TIDAK_DITEMUKAN', pesan: 'Template kuesioner tidak ditemukan' });
  }
}
