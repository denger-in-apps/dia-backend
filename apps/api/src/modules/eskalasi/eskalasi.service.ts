import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { PrioritasSos } from '../../common/domain/sos';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { SumberEskalasi } from './eskalasi.constants';

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

/**
 * Inti eskalasi SOS (PBI-09, FR-ADM-05; use case GENTA alt 3.a–3.b).
 *
 * Satu UPDATE bersyarat `WHERE status_penanganan = 'BARU'` menjamin:
 * - SOS yang sudah diambil psikolog atau dibatalkan mahasiswa (salah tekan) tidak dieskalasi;
 * - timer BullMQ, sweeper DB, dan eskalasi "tanpa psikolog" yang berjalan bersamaan
 *   (atau di beberapa instance) hanya menghasilkan satu eskalasi.
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
  ) {}

  /** @returns `true` bila SOS ini benar-benar dieskalasi oleh pemanggil ini. */
  async eskalasi(idSos: string, sumber: SumberEskalasi): Promise<boolean> {
    const result = await this.pool.query<SosTereskalasi>(
      `UPDATE log_sos
       SET status_penanganan = 'ESKALASI', waktu_eskalasi = now()
       WHERE id_sos = $1 AND status_penanganan = 'BARU'
       RETURNING id_sos::text AS id_sos, id_mahasiswa::text AS id_mahasiswa, prioritas, situasi,
                 lokasi_izin, perlu_verifikasi, waktu_kejadian, waktu_eskalasi`,
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
    return true;
  }
}
