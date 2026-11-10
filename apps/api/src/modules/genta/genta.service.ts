import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { PrioritasSos, SQL_STATUS_SOS_AKTIF, StatusSos } from '../../common/domain/sos';
import { SITUASI_SOS, SituasiSos, tentukanPrioritas } from './genta.constants';
import { BuatSosDto, LokasiDto } from './genta.dto';
import { SosKonfirmasiService } from './sos-konfirmasi.service';
import { SosLokasiService } from './sos-lokasi.service';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { EskalasiSchedulerService } from '../eskalasi/eskalasi-scheduler.service';
import { KonfigurasiSosService } from '../eskalasi/konfigurasi-sos.service';

export interface Hotline {
  label: string;
  aktif: boolean;
}

export interface SosMahasiswa {
  id_sos: string;
  waktu_kejadian: Date;
  situasi: SituasiSos | null;
  prioritas: PrioritasSos;
  status_penanganan: StatusSos;
  lokasi_izin: boolean;
  lokasi_diperbarui_at: Date | null;
  /** Terisi bila SOS tereskalasi karena tidak direspons tepat waktu (PBI-09). */
  waktu_eskalasi: Date | null;
  eskalasi_119: boolean;
  waktu_diambil: Date | null;
  waktu_selesai: Date | null;
}

export interface HasilBuatSos {
  /** `false` bila SOS aktif sudah ada dan dikembalikan (idempoten), bukan dibuat ulang. */
  baru: boolean;
  sos: SosMahasiswa;
  hotline: Hotline;
}

const SOS_COLUMNS = `id_sos::text AS id_sos, waktu_kejadian, situasi, prioritas, status_penanganan,
  lokasi_izin, lokasi_diperbarui_at, waktu_eskalasi, eskalasi_119, waktu_diambil, waktu_selesai`;

const UNIQUE_VIOLATION = '23505';

/** PBI-05 / FR-MHS-03: mahasiswa menekan tombol SOS (Genta). */
@Injectable()
export class GentaService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly konfirmasi: SosKonfirmasiService,
    private readonly lokasi: SosLokasiService,
    private readonly notifikasi: SosNotifikasiService,
    private readonly eskalasi: EskalasiSchedulerService,
    private readonly konfigurasi: KonfigurasiSosService,
  ) {}

  async mintaKonfirmasi(idMahasiswa: string) {
    const [terbit, hotline] = await Promise.all([
      this.konfirmasi.terbitkan(idMahasiswa),
      this.hotline(),
    ]);
    return {
      ...terbit,
      situasi_opsi: Object.entries(SITUASI_SOS).map(([kode, value]) => ({ kode, label: value.label })),
      hotline,
    };
  }

  async buatSos(idMahasiswa: string, dto: BuatSosDto): Promise<HasilBuatSos> {
    const { jti } = await this.konfirmasi.verifikasi(idMahasiswa, dto.token_konfirmasi);
    // Ambang anti-penyalahgunaan diatur Dosen Admin di konfigurasi_sos (SCRUM-236).
    const config = await this.konfigurasi.ambil();
    const hotline = { label: config.hotline_label, aktif: config.hotline_aktif };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialisasi per mahasiswa: tekan ganda/retry jaringan tidak membuat SOS ganda.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`genta:${idMahasiswa}`]);

      // Idempoten: SOS yang masih berjalan dikembalikan (retry dengan token yang sama tetap aman).
      const aktif = await this.sosAktif(client, idMahasiswa);
      if (aktif) {
        // Retry yang membawa lokasi tetap menyimpan lokasi pada SOS yang sama.
        const sos = dto.lokasi
          ? await this.simpanLokasi(client, idMahasiswa, aktif.id_sos, dto.lokasi) ?? aktif
          : aktif;
        await client.query('COMMIT');
        return { baru: false, sos, hotline };
      }

      if (!(await this.konfirmasi.pakai(jti))) {
        throw new UnprocessableEntityException({
          kode: 'KONFIRMASI_SUDAH_DIPAKAI',
          pesan: 'Konfirmasi sudah dipakai, ulangi konfirmasi',
        });
      }

      const riwayat = await client.query<{ per_jam: number; iseng: number; batal: number }>(
        `SELECT
           count(*) FILTER (WHERE waktu_kejadian > now() - interval '1 hour')::int AS per_jam,
           count(*) FILTER (WHERE ditandai_iseng AND waktu_kejadian > now() - interval '30 days')::int AS iseng,
           count(*) FILTER (WHERE alasan_selesai = 'DIBATALKAN_MAHASISWA'
                              AND waktu_kejadian > now() - interval '24 hours')::int AS batal
         FROM log_sos WHERE id_mahasiswa = $1 AND waktu_kejadian > now() - interval '30 days'`,
        [idMahasiswa],
      );
      const { per_jam, iseng, batal } = riwayat.rows[0];
      if (per_jam >= config.sos_maks_per_jam) {
        throw new HttpException({
          kode: 'SOS_TERLALU_SERING',
          pesan: 'Terlalu banyak permintaan SOS dalam satu jam. Jika Anda dalam bahaya, segera hubungi hotline.',
          detail: { hotline },
        }, HttpStatus.TOO_MANY_REQUESTS);
      }

      const perluVerifikasi = iseng >= config.sos_ambang_iseng_30_hari || batal >= config.sos_ambang_batal_24_jam;
      const idSos = randomUUID();
      const koordinat = dto.lokasi ? this.lokasi.enkripsi(idSos, dto.lokasi) : null;
      const inserted = await client.query<SosMahasiswa>(
        `INSERT INTO log_sos (id_sos, id_mahasiswa, situasi, prioritas, perlu_verifikasi,
                              lokasi_izin, koordinat_lokasi_enc, lokasi_diperbarui_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 THEN now() END)
         RETURNING ${SOS_COLUMNS}`,
        [
          idSos, idMahasiswa, dto.situasi, tentukanPrioritas(dto.situasi, perluVerifikasi),
          perluVerifikasi, koordinat !== null, koordinat,
        ],
      );
      await client.query('COMMIT');
      const sos = inserted.rows[0];
      // Setelah commit: jalankan timer eskalasi (PBI-09) dan kabari psikolog seketika (FR-PSI-03).
      // Tidak di-await agar respons ke mahasiswa tidak tertunda; keduanya tidak pernah melempar
      // error ke sini, dan sweeper DB menjadi jaring pengaman bila penjadwalan gagal.
      this.lanjutkanSetelahSosDibuat(sos, perluVerifikasi);
      return { baru: true, sos, hotline };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Jaminan terakhir indeks unik parsial: kembalikan SOS aktif yang sudah ada.
        const aktif = await this.sosAktif(this.pool, idMahasiswa);
        if (aktif) return { baru: false, sos: aktif, hotline };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private lanjutkanSetelahSosDibuat(sos: SosMahasiswa, perluVerifikasi: boolean): void {
    void this.eskalasi.jadwalkan(sos.id_sos).catch(() => undefined);
    void this.notifikasi.sosBaru({
      id_sos: sos.id_sos,
      prioritas: sos.prioritas,
      situasi: sos.situasi,
      situasi_label: sos.situasi ? SITUASI_SOS[sos.situasi].label : null,
      waktu_kejadian: new Date(sos.waktu_kejadian).toISOString(),
      lokasi_tersedia: sos.lokasi_izin,
      perlu_verifikasi: perluVerifikasi,
    })
      // Tidak ada psikolog (jaga) → eskalasi seketika sesuai konfigurasi admin.
      .then((hasil) => this.eskalasi.tindakLanjutPenerima(sos.id_sos, hasil.penerima, hasil.tanpa_jaga))
      .catch(() => undefined);
  }

  async statusAktif(idMahasiswa: string): Promise<{ sos: SosMahasiswa | null; hotline: Hotline }> {
    const [sos, hotline] = await Promise.all([this.sosAktif(this.pool, idMahasiswa), this.hotline()]);
    return { sos, hotline };
  }

  /** Batalkan SOS yang belum diambil psikolog (salah tekan). */
  async batalkan(idMahasiswa: string, idSos: string): Promise<SosMahasiswa> {
    const result = await this.pool.query<SosMahasiswa>(
      `UPDATE log_sos
       SET status_penanganan = 'SELESAI', alasan_selesai = 'DIBATALKAN_MAHASISWA', waktu_selesai = now(),
           koordinat_lokasi_enc = NULL
       WHERE id_sos = $1 AND id_mahasiswa = $2 AND status_penanganan = 'BARU'
       RETURNING ${SOS_COLUMNS}`,
      [idSos, idMahasiswa],
    );
    if (result.rows[0]) return result.rows[0];

    const existing = await this.pool.query<{ status_penanganan: StatusSos }>(
      `SELECT status_penanganan FROM log_sos WHERE id_sos = $1 AND id_mahasiswa = $2`,
      [idSos, idMahasiswa],
    );
    const status = existing.rows[0]?.status_penanganan;
    if (!status) throw new NotFoundException({ kode: 'SOS_TIDAK_DITEMUKAN', pesan: 'SOS tidak ditemukan' });
    if (status === 'SELESAI') {
      throw new ConflictException({ kode: 'SOS_SUDAH_SELESAI', pesan: 'SOS sudah selesai' });
    }
    throw new ConflictException({
      kode: 'SOS_SUDAH_DITANGANI',
      pesan: 'SOS sudah ditangani psikolog dan tidak dapat dibatalkan dari aplikasi',
    });
  }

  /**
   * Berbagi / memperbarui lokasi pada SOS milik sendiri yang masih berjalan
   * (mis. izin lokasi baru diberikan setelah SOS dikirim, atau posisi berpindah).
   */
  async bagikanLokasi(idMahasiswa: string, idSos: string, lokasi: LokasiDto): Promise<SosMahasiswa> {
    const sos = await this.simpanLokasi(this.pool, idMahasiswa, idSos, lokasi);
    if (sos) return sos;
    throw await this.sosTidakBisaDiubah(idMahasiswa, idSos);
  }

  /** Mencabut izin lokasi: koordinat dihapus, psikolog tidak lagi dapat melihatnya. */
  async cabutLokasi(idMahasiswa: string, idSos: string): Promise<SosMahasiswa> {
    const result = await this.pool.query<SosMahasiswa>(
      `UPDATE log_sos
       SET lokasi_izin = false, koordinat_lokasi_enc = NULL, lokasi_diperbarui_at = now()
       WHERE id_sos = $1 AND id_mahasiswa = $2
       RETURNING ${SOS_COLUMNS}`,
      [idSos, idMahasiswa],
    );
    if (!result.rows[0]) throw new NotFoundException({ kode: 'SOS_TIDAK_DITEMUKAN', pesan: 'SOS tidak ditemukan' });
    return result.rows[0];
  }

  private async simpanLokasi(
    executor: Pool | PoolClient,
    idMahasiswa: string,
    idSos: string,
    lokasi: LokasiDto,
  ): Promise<SosMahasiswa | null> {
    const result = await executor.query<SosMahasiswa>(
      `UPDATE log_sos
       SET lokasi_izin = true, koordinat_lokasi_enc = $3, lokasi_diperbarui_at = now()
       WHERE id_sos = $1 AND id_mahasiswa = $2 AND status_penanganan IN ${SQL_STATUS_SOS_AKTIF}
       RETURNING ${SOS_COLUMNS}`,
      [idSos, idMahasiswa, this.lokasi.enkripsi(idSos, lokasi)],
    );
    return result.rows[0] ?? null;
  }

  private async sosTidakBisaDiubah(idMahasiswa: string, idSos: string): Promise<Error> {
    const existing = await this.pool.query(
      `SELECT 1 FROM log_sos WHERE id_sos = $1 AND id_mahasiswa = $2`,
      [idSos, idMahasiswa],
    );
    if (!existing.rowCount) {
      return new NotFoundException({ kode: 'SOS_TIDAK_DITEMUKAN', pesan: 'SOS tidak ditemukan' });
    }
    return new ConflictException({ kode: 'SOS_SUDAH_SELESAI', pesan: 'SOS sudah selesai' });
  }

  private async sosAktif(executor: Pool | PoolClient, idMahasiswa: string): Promise<SosMahasiswa | null> {
    const result = await executor.query<SosMahasiswa>(
      `SELECT ${SOS_COLUMNS} FROM log_sos
       WHERE id_mahasiswa = $1 AND status_penanganan IN ${SQL_STATUS_SOS_AKTIF}
       ORDER BY waktu_kejadian DESC LIMIT 1`,
      [idMahasiswa],
    );
    return result.rows[0] ?? null;
  }

  private async hotline(): Promise<Hotline> {
    const config = await this.konfigurasi.ambil();
    return { label: config.hotline_label, aktif: config.hotline_aktif };
  }
}
