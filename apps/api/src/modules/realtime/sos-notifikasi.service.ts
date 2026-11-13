import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { PrioritasSos, StatusSos } from '../../common/domain/sos';
import { PsikologGateway } from './psikolog.gateway';
import { EVENT } from './realtime.constants';
import { sqlSedangJaga, zonaWaktuJadwal } from '../../common/domain/zona-waktu';

/** Payload `sos:baru`. Sengaja tanpa identitas mahasiswa; detail diambil lewat dashboard. */
export interface SosBaruPayload {
  id_sos: string;
  prioritas: PrioritasSos;
  situasi: string | null;
  situasi_label: string | null;
  waktu_kejadian: string;
  lokasi_tersedia: boolean;
  perlu_verifikasi: boolean;
}

export interface SosDiperbaruiPayload {
  id_sos: string;
  status_penanganan: StatusSos;
  id_psikolog: string | null;
}

/** Payload `sos:eskalasi`: SOS belum diambil setelah batas waktu (atau tanpa psikolog jaga). */
export interface SosEskalasiPayload {
  id_sos: string;
  prioritas: PrioritasSos;
  situasi: string | null;
  waktu_kejadian: string;
  waktu_eskalasi: string;
  lokasi_tersedia: boolean;
  perlu_verifikasi: boolean;
  sumber: string;
}

/** Payload `sos:lokasi`. */
export interface SosLokasiPayload {
  id_sos: string;
  lokasi_tersedia: boolean;
  lokasi_diperbarui_at: string | null;
}

export interface HasilNotifikasi {
  penerima: number;
  /** `true` bila tidak ada psikolog terjadwal jaga sehingga dikirim ke semua psikolog aktif. */
  tanpa_jaga: boolean;
}

/**
 * Notifikasi SOS ke psikolog (PBI-07, FR-PSI-03).
 * Penerima = psikolog aktif yang terjadwal jaga saat ini (`jadwal_jaga`, zona
 * `JADWAL_ZONA_WAKTU`, default Asia/Jakarta). Bila tidak ada yang jaga, semua psikolog
 * aktif dikabari agar SOS tidak pernah tanpa penerima. Event realtime dikirim lebih
 * dulu (target < 5 detik), lalu notifikasi in-app disimpan untuk psikolog yang offline.
 * Kegagalan notifikasi tidak pernah menggagalkan pembuatan SOS.
 */
@Injectable()
export class SosNotifikasiService {
  private readonly logger = new Logger(SosNotifikasiService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly gateway: PsikologGateway,
  ) {}

  async sosBaru(sos: SosBaruPayload): Promise<HasilNotifikasi> {
    try {
      let penerima = await this.psikologJaga();
      let tanpaJaga = false;
      if (penerima.length === 0) {
        penerima = await this.semuaPsikologAktif();
        tanpaJaga = true;
      }
      const payload = { ...sos, tanpa_jaga: tanpaJaga };
      this.gateway.kirimKePsikolog(penerima, EVENT.SOS_BARU, payload);
      if (penerima.length > 0) {
        await this.pool.query(
          `INSERT INTO notifikasi (id_penerima, role, jenis, payload)
           SELECT penerima, 'PSIKOLOG', 'SOS_BARU', $2::jsonb FROM unnest($1::uuid[]) AS penerima`,
          [penerima, JSON.stringify(payload)],
        );
      } else {
        this.logger.error(`SOS ${sos.id_sos} tidak memiliki penerima: tidak ada psikolog aktif`);
      }
      return { penerima: penerima.length, tanpa_jaga: tanpaJaga };
    } catch (error) {
      this.logger.error(`Gagal mengirim notifikasi SOS ${sos.id_sos}: ${(error as Error).message}`);
      return { penerima: 0, tanpa_jaga: false };
    }
  }

  /**
   * SOS tereskalasi: semua psikolog aktif (bukan hanya yang jaga) dikabari dan
   * notifikasi in-app disimpan. Tidak pernah melempar error.
   */
  async sosEskalasi(payload: SosEskalasiPayload): Promise<number> {
    try {
      const penerima = await this.semuaPsikologAktif();
      this.gateway.kirimKePsikolog(penerima, EVENT.SOS_ESKALASI, payload);
      if (penerima.length > 0) {
        await this.pool.query(
          `INSERT INTO notifikasi (id_penerima, role, jenis, payload)
           SELECT penerima, 'PSIKOLOG', 'SOS_ESKALASI', $2::jsonb FROM unnest($1::uuid[]) AS penerima`,
          // `eskalasi: true` dipertahankan untuk klien lama yang masih memeriksa flag ini.
          [penerima, JSON.stringify({ ...payload, eskalasi: true })],
        );
      }
      return penerima.length;
    } catch (error) {
      this.logger.error(`Gagal mengirim notifikasi eskalasi SOS ${payload.id_sos}: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Beritahu semua psikolog terhubung bahwa status kasus berubah (mis. sudah diambil). */
  sosDiperbarui(payload: SosDiperbaruiPayload): void {
    try {
      this.gateway.kirimKeSemuaPsikolog(EVENT.SOS_DIPERBARUI, payload);
    } catch (error) {
      this.logger.error(`Gagal menyiarkan pembaruan SOS ${payload.id_sos}: ${(error as Error).message}`);
    }
  }

  /**
   * Lokasi SOS berubah: penangan dikabari secara tertarget; kasus di antrean disiarkan ke
   * semua psikolog (hanya flag `lokasi_tersedia`). Tidak pernah memuat koordinat.
   */
  lokasiDiperbarui(idPsikolog: string | null, payload: SosLokasiPayload): void {
    try {
      if (idPsikolog) this.gateway.kirimKePsikolog([idPsikolog], EVENT.SOS_LOKASI, payload);
      else this.gateway.kirimKeSemuaPsikolog(EVENT.SOS_LOKASI, payload);
    } catch (error) {
      this.logger.error(`Gagal menyiarkan lokasi SOS ${payload.id_sos}: ${(error as Error).message}`);
    }
  }

  private async psikologJaga(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT p.id_psikolog::text AS id
       FROM jadwal_jaga j
       JOIN psikolog p ON p.id_psikolog = j.id_psikolog
       WHERE p.status_akun = 'AKTIF' AND ${sqlSedangJaga('$1')}`,
      [zonaWaktuJadwal()],
    );
    return result.rows.map((row) => row.id);
  }

  private async semuaPsikologAktif(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id_psikolog::text AS id FROM psikolog WHERE status_akun = 'AKTIF'`,
    );
    return result.rows.map((row) => row.id);
  }

}
