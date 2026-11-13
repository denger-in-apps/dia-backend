/** Nilai enum PostgreSQL `status_sesi`. */
export type StatusSesi = 'DIJADWALKAN' | 'BERLANGSUNG' | 'SELESAI' | 'DIBATALKAN' | 'TIDAK_HADIR';

/** Nilai enum PostgreSQL `tipe_sesi`. */
export const TIPE_SESI = ['CHAT', 'SUARA', 'TATAP_MUKA'] as const;
export type TipeSesi = (typeof TIPE_SESI)[number];

/**
 * Status yang "memegang" slot waktu. Harus sama dengan predikat exclusion constraint
 * `sesi_tidak_bentrok_*` di `0001_init.sql`; literal konstan, bukan input pengguna.
 */
export const SQL_STATUS_SESI_AKTIF = `('DIJADWALKAN', 'BERLANGSUNG')`;

/** Status akhir (riwayat). */
export const SQL_STATUS_SESI_RIWAYAT = `('SELESAI', 'DIBATALKAN', 'TIDAK_HADIR')`;

/** AAD enkripsi kolom `sesi_konseling` (EncryptionService mengikat ciphertext ke barisnya). */
export const aadSesi = (kolom: 'keluhan_awal_enc' | 'catatan_ringkasan_enc', idSesi: string): string =>
  `sesi_konseling:${kolom}:${idSesi}`;
