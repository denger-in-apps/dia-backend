import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrioritasSos, StatusSos } from '../../common/domain/sos';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { SITUASI_SOS, SituasiSos } from './genta.constants';
import { CakupanAntrean, DaftarSosQuery, UbahStatusSosDto } from './genta-psikolog.dto';
import { LokasiSos, SosLokasiService } from './sos-lokasi.service';

export interface KonteksPermintaan {
  ip?: string;
  userAgent?: string;
}

export interface LokasiUntukPsikolog extends LokasiSos {
  id_sos: string;
  lokasi_diperbarui_at: Date | null;
  /** Tautan peta untuk tampilan saja; koordinat berasal dari perangkat mahasiswa. */
  peta_url: string;
}

export interface SosAntrean {
  id_sos: string;
  waktu_kejadian: Date;
  situasi: SituasiSos | null;
  situasi_label: string | null;
  prioritas: PrioritasSos;
  status_penanganan: StatusSos;
  perlu_verifikasi: boolean;
  lokasi_tersedia: boolean;
  sudah_diambil: boolean;
  milik_saya: boolean;
  waktu_diambil: Date | null;
  waktu_ditangani: Date | null;
  waktu_selesai: Date | null;
  /** Hanya terisi untuk kasus yang diambil psikolog ini. */
  nama_mahasiswa: string | null;
}

export interface DetailSos extends SosAntrean {
  alasan_selesai: string | null;
  ditandai_iseng: boolean;
  /** Identitas & catatan hanya untuk psikolog penangan; `null` untuk kasus di antrean. */
  mahasiswa: { nim: string; nama: string; email: string } | null;
  riwayat_30_hari: { total_sos: number; laporan_tidak_valid: number } | null;
  catatan_penanganan: string | null;
}

/** Status yang masih menunggu diambil psikolog. */
const STATUS_ANTREAN: StatusSos[] = ['BARU', 'ESKALASI'];
/** Status kasus yang sedang dipegang psikolog. */
const STATUS_DIPEGANG: StatusSos[] = ['DIAMBIL', 'DITANGANI'];

const ANTREAN_COLUMNS = `s.id_sos::text AS id_sos, s.waktu_kejadian, s.situasi, s.prioritas, s.status_penanganan,
  s.perlu_verifikasi, s.lokasi_izin AS lokasi_tersedia, (s.id_psikolog IS NOT NULL) AS sudah_diambil,
  COALESCE(s.id_psikolog = $1::uuid, false) AS milik_saya, s.waktu_diambil, s.waktu_ditangani, s.waktu_selesai,
  CASE WHEN s.id_psikolog = $1::uuid THEN COALESCE(m.nama_tampilan, m.nama) END AS nama_mahasiswa`;

const FILTER_CAKUPAN: Record<CakupanAntrean, string> = {
  aktif: `(s.status_penanganan IN ('BARU', 'ESKALASI')
           OR (s.id_psikolog = $1::uuid AND s.status_penanganan IN ('DIAMBIL', 'DITANGANI')))`,
  antrean: `s.status_penanganan IN ('BARU', 'ESKALASI')`,
  milik_saya: `s.id_psikolog = $1::uuid AND s.status_penanganan IN ('DIAMBIL', 'DITANGANI')`,
  riwayat: `s.id_psikolog = $1::uuid AND s.status_penanganan = 'SELESAI'`,
};

/** Fitur Genta dari sisi psikolog: dashboard antrean & penanganan (PBI-08) dan lokasi (PBI-06). */
@Injectable()
export class GentaPsikologService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly lokasi: SosLokasiService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly notifikasi: SosNotifikasiService,
  ) {}

  /** Antrean SOS, urut prioritas tertinggi lalu yang paling lama menunggu (FR-PSI-02). */
  async daftar(psikolog: AuthenticatedUser, query: DaftarSosQuery): Promise<SosAntrean[]> {
    const cakupan = query.cakupan ?? 'aktif';
    const urutan = cakupan === 'riwayat'
      ? 's.waktu_selesai DESC'
      : 's.prioritas DESC, s.waktu_kejadian ASC';
    const result = await this.pool.query<Omit<SosAntrean, 'situasi_label'>>(
      `SELECT ${ANTREAN_COLUMNS}
       FROM log_sos s JOIN mahasiswa m ON m.id_mahasiswa = s.id_mahasiswa
       WHERE ${FILTER_CAKUPAN[cakupan]}
       ORDER BY ${urutan}
       LIMIT $2`,
      [psikolog.id, query.limit ?? 50],
    );
    return result.rows.map((row) => this.withLabel(row));
  }

  /**
   * Detail kasus. Kasus di antrean dapat dilihat semua psikolog tanpa identitas
   * mahasiswa; identitas, riwayat, dan catatan hanya untuk psikolog penangan (diaudit).
   */
  async detail(psikolog: AuthenticatedUser, idSos: string, ctx: KonteksPermintaan): Promise<DetailSos> {
    const result = await this.pool.query<Omit<DetailSos, 'situasi_label' | 'mahasiswa' | 'riwayat_30_hari' | 'catatan_penanganan'> & {
      nim: string;
      nama_asli: string;
      email: string;
      catatan_penanganan_enc: Buffer | null;
      total_sos: number;
      laporan_tidak_valid: number;
    }>(
      `SELECT ${ANTREAN_COLUMNS}, s.alasan_selesai, s.ditandai_iseng, s.catatan_penanganan_enc,
              m.nim, COALESCE(m.nama_tampilan, m.nama) AS nama_asli, m.email::text AS email,
              (SELECT count(*)::int FROM log_sos r
                WHERE r.id_mahasiswa = s.id_mahasiswa AND r.waktu_kejadian > now() - interval '30 days') AS total_sos,
              (SELECT count(*)::int FROM log_sos r
                WHERE r.id_mahasiswa = s.id_mahasiswa AND r.ditandai_iseng
                  AND r.waktu_kejadian > now() - interval '30 days') AS laporan_tidak_valid
       FROM log_sos s JOIN mahasiswa m ON m.id_mahasiswa = s.id_mahasiswa
       WHERE s.id_sos = $2`,
      [psikolog.id, idSos],
    );
    const row = result.rows[0];
    // Audit hanya untuk akses data sensitif (identitas/catatan) dan percobaan yang ditolak; metadata
    // berisi kode alasan saja — tidak pernah identitas mahasiswa, catatan, koordinat, atau token.
    const auditBase = {
      aktor: psikolog, aksi: 'SOS_DETAIL_READ', resourceType: 'log_sos', resourceId: idSos,
      ip: ctx.ip, userAgent: ctx.userAgent,
    };
    if (!row) {
      await this.audit.catat({ ...auditBase, hasil: 'DITOLAK', metadata: { alasan: 'SOS_TIDAK_DITEMUKAN' } });
      throw this.sosTidakDitemukan();
    }

    const {
      nim, nama_asli, email, catatan_penanganan_enc, total_sos, laporan_tidak_valid, ...sos
    } = row;
    if (sos.milik_saya) {
      // Dekripsi lebih dulu: SUKSES baru dicatat setelah seluruh data sensitif berhasil disiapkan.
      let catatan: string | null = null;
      if (catatan_penanganan_enc) {
        try {
          catatan = this.encryption.decrypt(catatan_penanganan_enc, this.aadCatatan(idSos)).toString('utf8');
        } catch {
          await this.audit.catat({ ...auditBase, hasil: 'DITOLAK', metadata: { alasan: 'DEKRIPSI_GAGAL' } });
          throw new InternalServerErrorException({
            kode: 'CATATAN_TIDAK_DAPAT_DIBUKA',
            pesan: 'Catatan penanganan tidak dapat dibuka. Hubungi admin sistem.',
          });
        }
      }
      await this.audit.catat({ ...auditBase, hasil: 'SUKSES' });
      return {
        ...this.withLabel(sos),
        mahasiswa: { nim, nama: nama_asli, email },
        riwayat_30_hari: { total_sos, laporan_tidak_valid },
        catatan_penanganan: catatan,
      };
    }
    if (STATUS_ANTREAN.includes(sos.status_penanganan)) {
      // Kasus di antrean: tanpa identitas/catatan, sehingga tidak ada data sensitif yang diaudit.
      return { ...this.withLabel(sos), mahasiswa: null, riwayat_30_hari: null, catatan_penanganan: null };
    }
    await this.audit.catat({ ...auditBase, hasil: 'DITOLAK', metadata: { alasan: 'BUKAN_PENANGAN_KASUS' } });
    throw this.bukanPenangan();
  }

  /**
   * Ambil kasus secara atomik (04-database.md §4.c): satu UPDATE bersyarat sehingga
   * dua psikolog yang mengambil bersamaan → tepat satu berhasil, lainnya 409.
   */
  async ambil(psikolog: AuthenticatedUser, idSos: string, ctx: KonteksPermintaan) {
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query<{ id_sos: string; status_penanganan: StatusSos; id_psikolog: string; waktu_diambil: Date }>(
        `UPDATE log_sos
         SET id_psikolog = $1, status_penanganan = 'DIAMBIL', waktu_diambil = now()
         WHERE id_sos = $2 AND status_penanganan IN ('BARU', 'ESKALASI')
         RETURNING id_sos::text AS id_sos, status_penanganan, id_psikolog::text AS id_psikolog, waktu_diambil`,
        [psikolog.id, idSos],
      );
      const taken = result.rows[0];
      if (!taken) {
        const current = await this.statusSaatIni(client, idSos);
        if (current.id_psikolog === psikolog.id && STATUS_DIPEGANG.includes(current.status_penanganan)) {
          return { ...current, id_sos: idSos }; // idempoten: sudah diambil oleh saya
        }
        if (current.status_penanganan === 'SELESAI') {
          throw new ConflictException({ kode: 'SOS_SUDAH_SELESAI', pesan: 'SOS sudah selesai' });
        }
        throw new ConflictException({ kode: 'SOS_SUDAH_DIAMBIL', pesan: 'SOS sudah diambil psikolog lain' });
      }
      await this.audit.catat({
        aktor: psikolog, aksi: 'SOS_AMBIL', resourceType: 'log_sos', resourceId: idSos,
        ip: ctx.ip, userAgent: ctx.userAgent,
      }, client);
      return taken;
    }).then((taken) => {
      this.notifikasi.sosDiperbarui({
        id_sos: taken.id_sos, status_penanganan: taken.status_penanganan, id_psikolog: taken.id_psikolog,
      });
      return taken;
    });
  }

  /** Perbarui status kasus milik sendiri: DIAMBIL → DITANGANI → SELESAI (atau langsung SELESAI). */
  async ubahStatus(psikolog: AuthenticatedUser, idSos: string, dto: UbahStatusSosDto, ctx: KonteksPermintaan) {
    if (dto.laporan_tidak_valid && dto.status !== 'SELESAI') {
      throw new BadRequestException({
        kode: 'STATUS_TIDAK_VALID',
        pesan: 'Laporan tidak valid hanya dapat ditandai saat menyelesaikan kasus',
      });
    }
    const selesai = dto.status === 'SELESAI';
    const tidakValid = selesai && dto.laporan_tidak_valid === true;
    const catatanEnc = dto.catatan !== undefined
      ? this.encryption.encrypt(dto.catatan, this.aadCatatan(idSos))
      : null;

    const updated = await denganTransaksi(this.pool, async (client) => {
      const result = await client.query<{ id_sos: string; status_penanganan: StatusSos; id_psikolog: string }>(
        `UPDATE log_sos
         SET status_penanganan = $3::status_sos,
             waktu_ditangani = CASE WHEN $7 THEN waktu_ditangani ELSE COALESCE(waktu_ditangani, now()) END,
             waktu_selesai = CASE WHEN $7 THEN now() END,
             alasan_selesai = $4,
             ditandai_iseng = $5,
             catatan_penanganan_enc = COALESCE($6, catatan_penanganan_enc),
             lokasi_izin = CASE WHEN $7 THEN false ELSE lokasi_izin END,
             koordinat_lokasi_enc = CASE WHEN $7 THEN NULL ELSE koordinat_lokasi_enc END
         WHERE id_sos = $1 AND id_psikolog = $2 AND status_penanganan IN ('DIAMBIL', 'DITANGANI')
         RETURNING id_sos::text AS id_sos, status_penanganan, id_psikolog::text AS id_psikolog`,
        [
          idSos, psikolog.id, dto.status,
          selesai ? (tidakValid ? 'LAPORAN_TIDAK_VALID' : 'DITANGANI') : null,
          tidakValid, catatanEnc, selesai,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        const current = await this.statusSaatIni(client, idSos);
        if (current.id_psikolog !== psikolog.id) throw this.bukanPenangan();
        throw new ConflictException({ kode: 'SOS_SUDAH_SELESAI', pesan: 'SOS sudah selesai' });
      }
      await this.audit.catat({
        aktor: psikolog, aksi: 'SOS_STATUS_UBAH', resourceType: 'log_sos', resourceId: idSos,
        ip: ctx.ip, userAgent: ctx.userAgent,
        metadata: { status: dto.status, laporan_tidak_valid: tidakValid },
      }, client);
      return row;
    });
    this.notifikasi.sosDiperbarui(updated);
    return updated;
  }

  /**
   * Lokasi SOS hanya untuk psikolog yang mengambil kasus tersebut, selama kasus
   * berjalan dan mahasiswa mengizinkan. Setiap akses (berhasil maupun ditolak)
   * dicatat sebagai `SOS_LOKASI_READ` di audit log.
   */
  async lokasiSos(psikolog: AuthenticatedUser, idSos: string, ctx: KonteksPermintaan): Promise<LokasiUntukPsikolog> {
    const result = await this.pool.query<{
      id_psikolog: string | null;
      status_penanganan: StatusSos;
      lokasi_izin: boolean;
      koordinat_lokasi_enc: Buffer | null;
      lokasi_diperbarui_at: Date | null;
    }>(
      `SELECT id_psikolog::text AS id_psikolog, status_penanganan, lokasi_izin,
              koordinat_lokasi_enc, lokasi_diperbarui_at
       FROM log_sos WHERE id_sos = $1`,
      [idSos],
    );

    const sos = result.rows[0];

    const auditBase = {
      aktor: psikolog,
      aksi: 'SOS_LOKASI_READ',
      resourceType: 'log_sos',
      resourceId: idSos,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };

    if (!sos) {
      // Percobaan membaca lokasi SOS yang tidak ada tetap diaudit (mis. menebak ID kasus).
      await this.audit.catat({
        ...auditBase,
        hasil: 'DITOLAK',
        metadata: { alasan: 'SOS_TIDAK_DITEMUKAN' },
      });
      throw this.sosTidakDitemukan();
    }

    if (sos.id_psikolog !== psikolog.id || !STATUS_DIPEGANG.includes(sos.status_penanganan)) {
      await this.audit.catat({
        ...auditBase,
        hasil: 'DITOLAK',
        metadata: { alasan: 'BUKAN_PENANGAN_KASUS' },
      });
      throw this.bukanPenangan();
    }

    if (!sos.lokasi_izin || !sos.koordinat_lokasi_enc) {
      await this.audit.catat({
        ...auditBase,
        hasil: 'DITOLAK',
        metadata: { alasan: 'LOKASI_TIDAK_DIBAGIKAN' },
      });

      throw new NotFoundException({
        kode: 'LOKASI_TIDAK_DIBAGIKAN',
        pesan: 'Mahasiswa tidak membagikan lokasi',
      });
    }

    const lokasi = this.lokasi.dekripsi(idSos, sos.koordinat_lokasi_enc);

    await this.audit.catat({
      ...auditBase,
      hasil: 'SUKSES',
    });

    return {
      id_sos: idSos,
      ...lokasi,
      lokasi_diperbarui_at: sos.lokasi_diperbarui_at,
      peta_url: `https://www.openstreetmap.org/?mlat=${lokasi.lat}&mlon=${lokasi.lng}#map=18/${lokasi.lat}/${lokasi.lng}`,
    };
  }

  private async statusSaatIni(client: PoolClient, idSos: string) {
    const result = await client.query<{ status_penanganan: StatusSos; id_psikolog: string | null }>(
      `SELECT status_penanganan, id_psikolog::text AS id_psikolog FROM log_sos WHERE id_sos = $1`,
      [idSos],
    );
    if (!result.rows[0]) throw this.sosTidakDitemukan();
    return result.rows[0];
  }

  private withLabel<T extends { situasi: SituasiSos | null }>(row: T): T & { situasi_label: string | null } {
    return { ...row, situasi_label: row.situasi ? SITUASI_SOS[row.situasi]?.label ?? null : null };
  }

  private aadCatatan(idSos: string): string {
    return `log_sos:catatan_penanganan_enc:${idSos}`;
  }

  private sosTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'SOS_TIDAK_DITEMUKAN', pesan: 'SOS tidak ditemukan' });
  }

  private bukanPenangan(): ForbiddenException {
    return new ForbiddenException({
      kode: 'BUKAN_PENANGAN_KASUS',
      pesan: 'Kasus ini ditangani psikolog lain',
    });
  }
}
