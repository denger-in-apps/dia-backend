import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { StatusSos } from '../../common/domain/sos';
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

/** Status ketika psikolog penangan boleh melihat lokasi (kasus sedang ditangani). */
const STATUS_LOKASI_BOLEH_DIBACA: StatusSos[] = ['DIAMBIL', 'DITANGANI'];

/** Fitur Genta dari sisi psikolog (FR-PSI-02/03, FR-MHS-04). */
@Injectable()
export class GentaPsikologService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly lokasi: SosLokasiService,
    private readonly audit: AuditService,
  ) {}

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
    if (!sos) throw new NotFoundException({ kode: 'SOS_TIDAK_DITEMUKAN', pesan: 'SOS tidak ditemukan' });

    const auditBase = {
      aktor: psikolog,
      aksi: 'SOS_LOKASI_READ',
      resourceType: 'log_sos',
      resourceId: idSos,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };
    if (sos.id_psikolog !== psikolog.id || !STATUS_LOKASI_BOLEH_DIBACA.includes(sos.status_penanganan)) {
      await this.audit.catat({ ...auditBase, hasil: 'DITOLAK', metadata: { alasan: 'BUKAN_PENANGAN_KASUS' } });
      throw new ForbiddenException({
        kode: 'BUKAN_PENANGAN_KASUS',
        pesan: 'Lokasi hanya dapat dilihat psikolog yang sedang menangani kasus ini',
      });
    }
    if (!sos.lokasi_izin || !sos.koordinat_lokasi_enc) {
      throw new NotFoundException({ kode: 'LOKASI_TIDAK_DIBAGIKAN', pesan: 'Mahasiswa tidak membagikan lokasi' });
    }

    const lokasi = this.lokasi.dekripsi(idSos, sos.koordinat_lokasi_enc);
    await this.audit.catat(auditBase);
    return {
      id_sos: idSos,
      ...lokasi,
      lokasi_diperbarui_at: sos.lokasi_diperbarui_at,
      peta_url: `https://www.openstreetmap.org/?mlat=${lokasi.lat}&mlon=${lokasi.lng}#map=18/${lokasi.lat}/${lokasi.lng}`,
    };
  }
}
