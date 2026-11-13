import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { PrioritasSos } from '../../common/domain/sos';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { KLAIM_KEDALUWARSA_DETIK, MAKS_PERCOBAAN_TINDAKAN, SumberEskalasi } from './eskalasi.constants';
import { EskalasiTindakanService } from './eskalasi-tindakan.service';

/** Baris SOS yang baru saja dieskalasi; diteruskan ke tindakan eskalasi (SMS/hotline). */
export interface SosTereskalasi {
  id_sos: string;
  id_mahasiswa: string;
  prioritas: PrioritasSos;
  situasi: string | null;
  lokasi_izin: boolean;
  perlu_verifikasi: boolean;
  waktu_kejadian: Date;
  waktu_eskalasi: Date;
}

const KOLOM_TERESKALASI = `id_sos::text AS id_sos, id_mahasiswa::text AS id_mahasiswa, prioritas, situasi,
  lokasi_izin, perlu_verifikasi, waktu_kejadian, waktu_eskalasi`;

/**
 * Inti eskalasi SOS (PBI-09, FR-ADM-05; use case GENTA alt 3.a–3.b).
 *
 * Satu UPDATE bersyarat `WHERE status_penanganan = 'BARU'` menjamin:
 * - SOS yang sudah diambil psikolog atau dibatalkan mahasiswa (salah tekan) tidak dieskalasi;
 * - timer BullMQ, sweeper DB, dan eskalasi "tanpa psikolog" yang berjalan bersamaan
 *   (atau di beberapa instance) hanya menghasilkan satu eskalasi.
 *
 * Tindakan (SMS + info hotline) memakai pola outbox (SCRUM-235): UPDATE yang sama
 * mengklaim tindakan (`tindakan_klaim_at`), dan `tindakan_eskalasi_at` baru diisi setelah
 * tindakan selesai. Bila proses mati / DB putus di tengah, `ulangiTindakanTertunda()`
 * (dipanggil sweeper) mengklaim ulang setelah `KLAIM_KEDALUWARSA_DETIK`, maks.
 * `MAKS_PERCOBAAN_TINDAKAN` kali, selama SOS masih `ESKALASI` (belum diambil psikolog).
 *
 * Eskalasi berlaku untuk semua SOS, termasuk yang bertanda `perlu_verifikasi`:
 * kecurigaan penyalahgunaan tidak boleh menghalangi bantuan bagi orang yang mungkin
 * benar-benar dalam bahaya.
 */
@Injectable()
export class EskalasiService {
  private readonly logger = new Logger(EskalasiService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly notifikasi: SosNotifikasiService,
    private readonly tindakan: EskalasiTindakanService,
  ) {}

  /** @returns `true` bila SOS ini benar-benar dieskalasi oleh pemanggil ini. */
  async eskalasi(idSos: string, sumber: SumberEskalasi): Promise<boolean> {
    const result = await this.pool.query<SosTereskalasi>(
      `UPDATE log_sos
       SET status_penanganan = 'ESKALASI', waktu_eskalasi = now(),
           tindakan_klaim_at = now(), tindakan_percobaan = 1
       WHERE id_sos = $1 AND status_penanganan = 'BARU'
       RETURNING ${KOLOM_TERESKALASI}`,
      [idSos],
    );
    const sos = result.rows[0];
    if (!sos) return false;

    this.logger.warn(`SOS ${idSos} dieskalasi (${sumber})`);
    this.notifikasi.sosDiperbarui({ id_sos: idSos, status_penanganan: 'ESKALASI', id_psikolog: null });
    await this.notifikasi.sosEskalasi({
      id_sos: idSos,
      prioritas: sos.prioritas,
      situasi: sos.situasi,
      waktu_kejadian: new Date(sos.waktu_kejadian).toISOString(),
      waktu_eskalasi: new Date(sos.waktu_eskalasi).toISOString(),
      lokasi_tersedia: sos.lokasi_izin,
      perlu_verifikasi: sos.perlu_verifikasi,
      sumber,
    });
    await this.jalankanTindakan(sos);
    return true;
  }

  /**
   * Klaim ulang tindakan eskalasi yang belum selesai (proses mati / DB putus / gagal total).
   * Klaim atomik (`FOR UPDATE SKIP LOCKED`) sehingga aman dijalankan sweeper di semua instance.
   * @returns jumlah tindakan yang berhasil diselesaikan.
   */
  async ulangiTindakanTertunda(): Promise<number> {
    const result = await this.pool.query<SosTereskalasi & { tindakan_percobaan: number }>(
      `UPDATE log_sos
       SET tindakan_klaim_at = now(), tindakan_percobaan = tindakan_percobaan + 1
       WHERE id_sos IN (
         SELECT id_sos FROM log_sos
         WHERE status_penanganan = 'ESKALASI' AND tindakan_eskalasi_at IS NULL
           AND tindakan_percobaan < $1
           AND (tindakan_klaim_at IS NULL OR tindakan_klaim_at < now() - make_interval(secs => $2::int))
         ORDER BY waktu_eskalasi
         LIMIT 20
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${KOLOM_TERESKALASI}, tindakan_percobaan`,
      [MAKS_PERCOBAAN_TINDAKAN, KLAIM_KEDALUWARSA_DETIK],
    );
    let selesai = 0;
    for (const { tindakan_percobaan, ...sos } of result.rows) {
      this.logger.warn(`Mengulang tindakan eskalasi SOS ${sos.id_sos} (percobaan ${tindakan_percobaan})`);
      if (await this.jalankanTindakan(sos)) selesai++;
      else if (tindakan_percobaan >= MAKS_PERCOBAAN_TINDAKAN) {
        this.logger.error(
          `Tindakan eskalasi SOS ${sos.id_sos} gagal setelah ${tindakan_percobaan} percobaan; perlu penanganan manual`,
        );
      }
    }
    return selesai;
  }

  /** Jalankan SMS + info hotline lalu tandai selesai. Tidak pernah melempar error. */
  private async jalankanTindakan(sos: SosTereskalasi): Promise<boolean> {
    // SMS kontak darurat & penerima eskalasi + info hotline (SCRUM-235). Penerima yang
    // sudah TERKIRIM pada percobaan sebelumnya dilewati sehingga retry tidak mengirim ganda.
    const tindakan = await this.tindakan.jalankan(sos);
    this.logger.warn(
      `SOS ${sos.id_sos}: SMS terkirim ${tindakan.sms_terkirim}, gagal ${tindakan.sms_gagal}` +
      (tindakan.kontak_darurat_dilewati ? `, kontak darurat dilewati (${tindakan.kontak_darurat_dilewati})` : ''),
    );
    if (!tindakan.selesai) return false;
    try {
      await this.pool.query(`UPDATE log_sos SET tindakan_eskalasi_at = now() WHERE id_sos = $1`, [sos.id_sos]);
      return true;
    } catch (error) {
      // Tidak fatal: sweeper akan mengulang dan melewati penerima yang sudah terkirim.
      this.logger.error(`Gagal menandai tindakan eskalasi SOS ${sos.id_sos}: ${(error as Error).message}`);
      return false;
    }
  }
}
