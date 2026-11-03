import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { PrioritasSos, SQL_STATUS_SOS_AKTIF, StatusSos } from '../../common/domain/sos';
import { gentaConfig, SITUASI_SOS, SituasiSos, tentukanPrioritas } from './genta.constants';
import { BuatSosDto } from './genta.dto';
import { SosKonfirmasiService } from './sos-konfirmasi.service';

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
  lokasi_izin, waktu_diambil, waktu_selesai`;

const UNIQUE_VIOLATION = '23505';

/** PBI-05 / FR-MHS-03: mahasiswa menekan tombol SOS (Genta). */
@Injectable()
export class GentaService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly konfirmasi: SosKonfirmasiService,
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
    const hotline = await this.hotline();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialisasi per mahasiswa: tekan ganda/retry jaringan tidak membuat SOS ganda.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`genta:${idMahasiswa}`]);

      // Idempoten: SOS yang masih berjalan dikembalikan (retry dengan token yang sama tetap aman).
      const aktif = await this.sosAktif(client, idMahasiswa);
      if (aktif) {
        await client.query('COMMIT');
        return { baru: false, sos: aktif, hotline };
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
      if (per_jam >= gentaConfig.maksPerJam()) {
        throw new HttpException({
          kode: 'SOS_TERLALU_SERING',
          pesan: 'Terlalu banyak permintaan SOS dalam satu jam. Jika Anda dalam bahaya, segera hubungi hotline.',
          detail: { hotline },
        }, HttpStatus.TOO_MANY_REQUESTS);
      }

      const perluVerifikasi = iseng >= gentaConfig.ambangIseng30Hari() || batal >= gentaConfig.ambangBatal24Jam();
      const inserted = await client.query<SosMahasiswa>(
        `INSERT INTO log_sos (id_mahasiswa, situasi, prioritas, perlu_verifikasi)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SOS_COLUMNS}`,
        [idMahasiswa, dto.situasi, tentukanPrioritas(dto.situasi, perluVerifikasi), perluVerifikasi],
      );
      await client.query('COMMIT');
      return { baru: true, sos: inserted.rows[0], hotline };
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

  async statusAktif(idMahasiswa: string): Promise<{ sos: SosMahasiswa | null; hotline: Hotline }> {
    const [sos, hotline] = await Promise.all([this.sosAktif(this.pool, idMahasiswa), this.hotline()]);
    return { sos, hotline };
  }

  /** Batalkan SOS yang belum diambil psikolog (salah tekan). */
  async batalkan(idMahasiswa: string, idSos: string): Promise<SosMahasiswa> {
    const result = await this.pool.query<SosMahasiswa>(
      `UPDATE log_sos
       SET status_penanganan = 'SELESAI', alasan_selesai = 'DIBATALKAN_MAHASISWA', waktu_selesai = now()
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
    const result = await this.pool.query<{ hotline_label: string; hotline_aktif: boolean }>(
      `SELECT hotline_label, hotline_aktif FROM konfigurasi_sos WHERE id = 1`,
    );
    const row = result.rows[0];
    return { label: row?.hotline_label ?? 'Healing119.id — 119 ext. 8', aktif: row?.hotline_aktif ?? true };
  }
}
