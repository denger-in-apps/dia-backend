import { Pool, PoolClient } from 'pg';
import { SQL_STATUS_SESI_AKTIF } from '../../common/domain/sesi';
import { zonaWaktuJadwal } from '../../common/domain/zona-waktu';
import { bookingConfig } from './booking.constants';

export interface SlotSesi {
  id_psikolog: string;
  nama_psikolog: string;
  waktu_mulai: Date;
  waktu_selesai: Date;
}

export interface OpsiCariSlot {
  /** Batasi ke satu psikolog; kosong = semua psikolog aktif. */
  idPsikolog?: string | null;
  /** Hanya slot dari shift pada tanggal lokal ini (`YYYY-MM-DD`, zona `JADWAL_ZONA_WAKTU`). */
  tanggal?: string | null;
  /** Rentang waktu mulai slot [dari, sampai). Default: sekarang s.d. horizon booking. */
  dari?: Date;
  sampai?: Date;
  /** `false` = abaikan sesi yang sudah ada (dipakai untuk memeriksa apakah waktu adalah slot sah). */
  cekKetersediaan?: boolean;
  /** Buang juga slot yang bentrok dengan sesi aktif mahasiswa ini. */
  idMahasiswa?: string | null;
  /** Abaikan sesi ini saat cek ketersediaan (ubah jadwal sesi itu sendiri). */
  kecualiSesi?: string | null;
  limit: number;
}

/**
 * Slot sesi konseling yang diturunkan dari `jadwal_jaga` psikolog AKTIF. Batas waktu
 * (minimal sebelum mulai, horizon) ditegakkan di SQL sehingga validasi booking dan
 * daftar slot memakai aturan yang persis sama. Ketersediaan diperiksa terhadap sesi
 * `DIJADWALKAN/BERLANGSUNG` dengan rentang setengah-terbuka, sama seperti exclusion
 * constraint `sesi_tidak_bentrok_*` (slot berurutan tidak dianggap bentrok).
 */
export async function cariSlot(executor: Pool | PoolClient, opsi: OpsiCariSlot): Promise<SlotSesi[]> {
  const durasi = bookingConfig.durasiMenit();
  const langkah = durasi + bookingConfig.jedaMenit();
  const result = await executor.query<SlotSesi>(
    `SELECT p.id_psikolog::text AS id_psikolog, p.nama AS nama_psikolog,
            gs AS waktu_mulai, gs + make_interval(mins => $5::int) AS waktu_selesai
     FROM jadwal_jaga j
     JOIN psikolog p ON p.id_psikolog = j.id_psikolog AND p.status_akun = 'AKTIF'
     CROSS JOIN LATERAL generate_series(
       (j.tanggal + j.jam_mulai) AT TIME ZONE $4::text,
       ((j.tanggal + j.jam_selesai) AT TIME ZONE $4::text) - make_interval(mins => $5::int),
       make_interval(mins => $6::int)
     ) AS gs
     WHERE ($1::uuid IS NULL OR j.id_psikolog = $1::uuid)
       AND ($12::date IS NULL OR j.tanggal = $12::date)
       AND j.tanggal BETWEEN ($2::timestamptz AT TIME ZONE $4::text)::date - 1
                         AND ($3::timestamptz AT TIME ZONE $4::text)::date
       AND gs >= $2::timestamptz AND gs < $3::timestamptz
       AND gs >= now() + make_interval(mins => $7::int)
       AND gs < now() + make_interval(days => $8::int)
       AND (NOT $9::boolean OR NOT EXISTS (
         SELECT 1 FROM sesi_konseling s
         WHERE s.status_sesi IN ${SQL_STATUS_SESI_AKTIF}
           AND s.id_sesi IS DISTINCT FROM $11::uuid
           AND (s.id_psikolog = j.id_psikolog OR s.id_mahasiswa = $10::uuid)
           AND tstzrange(s.waktu_mulai, s.waktu_selesai) && tstzrange(gs, gs + make_interval(mins => $5::int))
       ))
     ORDER BY gs, p.nama
     LIMIT $13`,
    [
      opsi.idPsikolog ?? null,
      (opsi.dari ?? new Date()).toISOString(),
      (opsi.sampai ?? new Date(Date.now() + bookingConfig.horizonHari() * 86_400_000)).toISOString(),
      zonaWaktuJadwal(),
      durasi,
      langkah,
      bookingConfig.minimalSebelumMenit(),
      bookingConfig.horizonHari(),
      opsi.cekKetersediaan ?? true,
      opsi.idMahasiswa ?? null,
      opsi.kecualiSesi ?? null,
      opsi.tanggal ?? null,
      opsi.limit,
    ],
  );
  return result.rows;
}

/** `true` bila `waktuMulai` tepat jatuh pada slot sah psikolog (tanpa memandang sudah dipesan atau belum). */
export async function slotSah(executor: Pool | PoolClient, idPsikolog: string, waktuMulai: Date): Promise<boolean> {
  const slot = await cariSlot(executor, {
    idPsikolog,
    dari: waktuMulai,
    sampai: new Date(waktuMulai.getTime() + 1),
    cekKetersediaan: false,
    limit: 1,
  });
  return slot.length === 1;
}
