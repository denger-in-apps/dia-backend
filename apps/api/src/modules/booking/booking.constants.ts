import { intEnv } from '../../common/domain/env';

/**
 * Parameter booking konseling (PBI-10). Slot diturunkan dari `jadwal_jaga` psikolog
 * (ERD: SESI_KONSELING ↔ JADWAL_JAGA): setiap shift dipecah menjadi slot sepanjang
 * `durasiMenit`, dimulai tiap `durasiMenit + jedaMenit` sejak jam mulai shift.
 */
export const bookingConfig = {
  /** Lama satu sesi konseling (menit). */
  durasiMenit: () => intEnv('SESI_DURASI_MENIT', 50, 15, 180),
  /** Jeda antarsesi untuk psikolog (menit). */
  jedaMenit: () => intEnv('SESI_JEDA_MENIT', 10, 0, 120),
  /** Booking/ubah jadwal paling lambat sekian menit sebelum sesi mulai. */
  minimalSebelumMenit: () => intEnv('BOOKING_MIN_SEBELUM_MENIT', 60, 0, 7 * 24 * 60),
  /** Slot hanya dapat dipesan sampai sekian hari ke depan. */
  horizonHari: () => intEnv('BOOKING_HORIZON_HARI', 30, 1, 180),
  /** Maksimal sesi mendatang (DIJADWALKAN/BERLANGSUNG) per mahasiswa — anti penimbunan slot. */
  maksSesiAktif: () => intEnv('BOOKING_MAKS_SESI_AKTIF', 3, 1, 20),
};

/** Jumlah slot alternatif yang ditawarkan saat bentrok (use case Booking alt 5.b: 3–5 slot). */
export const JUMLAH_ALTERNATIF = 5;

/** Rentang (jam) pencarian psikolog lain di sekitar waktu yang diminta. */
export const RENTANG_ALTERNATIF_JAM = 3;
