import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { StatusSesi, TipeSesi } from '../../common/domain/sesi';
import { zonaWaktuJadwal } from '../../common/domain/zona-waktu';
import { EMAIL_PROVIDER, EmailProvider, maskEmail } from './email/email.provider';
import { BATCH_PENGINGAT, LEASE_DETIK, offsetPengingat, pengingatConfig } from './pengingat.constants';

export interface SesiUntukPengingat {
  id_sesi: string;
  waktu_mulai: Date;
  status_sesi: StatusSesi;
}

interface PengingatJatuhTempo {
  id_sesi: string;
  offset_menit: number;
  percobaan: number;
  waktu_mulai: Date;
  tipe_sesi: TipeSesi;
  id_mahasiswa: string;
  id_psikolog: string;
  email: string;
  nama_mahasiswa: string;
  nama_psikolog: string;
  mahasiswa_dihapus: boolean;
}

export interface HasilProses {
  diproses: number;
  terkirim: number;
  gagal: number;
}

const LABEL_TIPE: Record<TipeSesi, string> = { CHAT: 'chat', SUARA: 'panggilan suara', TATAP_MUKA: 'tatap muka' };

/**
 * Pengingat sesi konseling (PBI-14, FR-MHS-11; 02-backend.md §9.4).
 *
 * - `jadwalkan()` dipanggil di dalam transaksi booking/ubah/batal sehingga baris
 *   `pengingat_sesi` selalu konsisten dengan jadwal sesi (PK `(id_sesi, offset_menit)`).
 * - `proses()` dijalankan worker tiap menit: klaim baris jatuh tempo dengan
 *   `FOR UPDATE SKIP LOCKED` + lease (aman multi-instance), buat notifikasi in-app
 *   tepat sekali, lalu kirim email dengan retry eksponensial maks. `PENGINGAT_MAKS_PERCOBAAN`.
 */
@Injectable()
export class PengingatService {
  private readonly logger = new Logger(PengingatService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /**
   * Atur ulang pengingat sesi: hapus yang lama, lalu buat offset yang masih di masa depan
   * bila sesi `DIJADWALKAN`. Sesi diubah jadwalnya → pengingat mengikuti waktu baru;
   * dibatalkan → tidak ada pengingat tersisa.
   */
  async jadwalkan(client: PoolClient, sesi: SesiUntukPengingat): Promise<void> {
    await client.query(`DELETE FROM pengingat_sesi WHERE id_sesi = $1`, [sesi.id_sesi]);
    if (sesi.status_sesi !== 'DIJADWALKAN') return;
    await client.query(
      `INSERT INTO pengingat_sesi (id_sesi, offset_menit)
       SELECT $1, o FROM unnest($2::int[]) AS o
       WHERE $3::timestamptz - make_interval(mins => o) > now()`,
      [sesi.id_sesi, offsetPengingat(), new Date(sesi.waktu_mulai).toISOString()],
    );
  }

  async proses(): Promise<HasilProses> {
    await this.tutupYangTidakRelevan();
    const klaim = await this.klaim();
    const hasil: HasilProses = { diproses: klaim.length, terkirim: 0, gagal: 0 };
    for (const item of klaim) {
      try {
        await this.buatInApp(item);
        if (await this.kirimEmail(item)) hasil.terkirim++;
        else hasil.gagal++;
      } catch (error) {
        // Lease akan kedaluwarsa dan baris dicoba lagi; jangan hentikan batch.
        hasil.gagal++;
        this.logger.error(`Pengingat sesi ${item.id_sesi} (${item.offset_menit} mnt) gagal: ${(error as Error).message}`);
      }
    }
    return hasil;
  }

  // ---------------------------------------------------------------------------

  /** Sesi yang batal/dimulai/lewat tidak perlu diingatkan lagi. */
  private async tutupYangTidakRelevan(): Promise<void> {
    await this.pool.query(
      `UPDATE pengingat_sesi pg SET status = 'GAGAL', error = 'SESI_TIDAK_RELEVAN', coba_lagi_at = NULL
       FROM sesi_konseling s
       WHERE pg.id_sesi = s.id_sesi AND pg.status = 'ANTRE'
         AND (s.status_sesi <> 'DIJADWALKAN' OR s.waktu_mulai <= now())`,
    );
  }

  private async klaim(): Promise<PengingatJatuhTempo[]> {
    const result = await this.pool.query<PengingatJatuhTempo>(
      `WITH due AS (
         SELECT pg.id_sesi, pg.offset_menit
         FROM pengingat_sesi pg JOIN sesi_konseling s ON s.id_sesi = pg.id_sesi
         WHERE pg.status = 'ANTRE' AND s.status_sesi = 'DIJADWALKAN' AND s.waktu_mulai > now()
           AND s.waktu_mulai - make_interval(mins => pg.offset_menit) <= now()
           AND (pg.coba_lagi_at IS NULL OR pg.coba_lagi_at <= now())
         ORDER BY s.waktu_mulai
         LIMIT $1
         FOR UPDATE OF pg SKIP LOCKED
       )
       UPDATE pengingat_sesi pg SET coba_lagi_at = now() + make_interval(secs => $2::int)
       FROM due, sesi_konseling s, mahasiswa m, psikolog p
       WHERE pg.id_sesi = due.id_sesi AND pg.offset_menit = due.offset_menit
         AND s.id_sesi = pg.id_sesi AND m.id_mahasiswa = s.id_mahasiswa AND p.id_psikolog = s.id_psikolog
       RETURNING pg.id_sesi::text AS id_sesi, pg.offset_menit, pg.percobaan, s.waktu_mulai, s.tipe_sesi,
                 s.id_mahasiswa::text AS id_mahasiswa, s.id_psikolog::text AS id_psikolog, m.email::text AS email,
                 COALESCE(m.nama_tampilan, m.nama) AS nama_mahasiswa, p.nama AS nama_psikolog,
                 (m.deleted_at IS NOT NULL) AS mahasiswa_dihapus`,
      [BATCH_PENGINGAT, LEASE_DETIK],
    );
    return result.rows;
  }

  /** In-app untuk mahasiswa & psikolog, tepat sekali (ditandai `inapp_at` di statement yang sama). */
  private async buatInApp(item: PengingatJatuhTempo): Promise<void> {
    const payload = JSON.stringify({
      id_sesi: item.id_sesi,
      waktu_mulai: new Date(item.waktu_mulai).toISOString(),
      tipe_sesi: item.tipe_sesi,
      menit_sebelum: item.offset_menit,
    });
    await this.pool.query(
      `WITH tandai AS (
         UPDATE pengingat_sesi SET inapp_at = now()
         WHERE id_sesi = $1 AND offset_menit = $2 AND inapp_at IS NULL
         RETURNING 1
       )
       INSERT INTO notifikasi (id_penerima, role, jenis, payload)
       SELECT penerima.id, penerima.role::role_pengguna, 'PENGINGAT_SESI', $5::jsonb
       FROM tandai, (VALUES ($3::uuid, 'MAHASISWA'), ($4::uuid, 'PSIKOLOG')) AS penerima(id, role)`,
      [item.id_sesi, item.offset_menit, item.id_mahasiswa, item.id_psikolog, payload],
    );
  }

  /** @returns `true` bila terkirim. Kegagalan dijadwalkan ulang atau ditandai GAGAL setelah batas percobaan. */
  private async kirimEmail(item: PengingatJatuhTempo): Promise<boolean> {
    const percobaan = item.percobaan + 1;
    if (item.mahasiswa_dihapus) {
      await this.selesai(item, 'GAGAL', percobaan, 'AKUN_DIHAPUS');
      return false;
    }
    try {
      await this.email.kirim({
        ke: item.email,
        subjek: 'Pengingat sesi konseling Denger.in',
        teks: this.teksEmail(item),
        idempotencyKey: `pengingat:${item.id_sesi}:${item.offset_menit}`,
      });
      await this.selesai(item, 'TERKIRIM', percobaan, null);
      return true;
    } catch (error) {
      const pesan = (error as Error).message.replaceAll(item.email, maskEmail(item.email)).slice(0, 500);
      if (percobaan >= pengingatConfig.maksPercobaan()) {
        await this.selesai(item, 'GAGAL', percobaan, pesan);
        this.logger.warn(`Email pengingat sesi ${item.id_sesi} gagal permanen setelah ${percobaan} percobaan`);
      } else {
        const jeda = pengingatConfig.retryDasarDetik() * 4 ** (percobaan - 1);
        await this.pool.query(
          `UPDATE pengingat_sesi SET percobaan = $3, error = $4, coba_lagi_at = now() + make_interval(secs => $5::int)
           WHERE id_sesi = $1 AND offset_menit = $2`,
          [item.id_sesi, item.offset_menit, percobaan, pesan, jeda],
        );
      }
      return false;
    }
  }

  private async selesai(
    item: PengingatJatuhTempo,
    status: 'TERKIRIM' | 'GAGAL',
    percobaan: number,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pengingat_sesi
       SET status = $3::status_kirim, percobaan = $4, error = $5, coba_lagi_at = NULL,
           dikirim_at = CASE WHEN $3 = 'TERKIRIM' THEN now() END
       WHERE id_sesi = $1 AND offset_menit = $2`,
      [item.id_sesi, item.offset_menit, status, percobaan, error],
    );
  }

  /** Tanpa topik keluhan atau isi sesi (02-backend.md §9.4). */
  private teksEmail(item: PengingatJatuhTempo): string {
    const waktu = new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'full', timeStyle: 'short', timeZone: zonaWaktuJadwal(),
    }).format(new Date(item.waktu_mulai));
    return [
      `Halo ${item.nama_mahasiswa},`,
      '',
      `Ini pengingat sesi konseling ${LABEL_TIPE[item.tipe_sesi]} Anda bersama ${item.nama_psikolog} pada ${waktu}.`,
      'Buka aplikasi Denger.in untuk bergabung. Bila berhalangan, ubah atau batalkan jadwal melalui aplikasi.',
      '',
      'Jika Anda dalam keadaan darurat, gunakan tombol Genta di aplikasi.',
    ].join('\n');
  }
}
