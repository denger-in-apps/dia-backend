/** Namespace Socket.IO khusus psikolog. Klien: `io('<origin>/psikolog', { auth: { token } })`. */
export const NAMESPACE_PSIKOLOG = '/psikolog';

/** Room per psikolog untuk notifikasi tertarget. */
export const roomPsikolog = (idPsikolog: string): string => `psikolog:${idPsikolog}`;

/** Room semua psikolog terhubung; untuk pembaruan antrean (mis. kasus sudah diambil). */
export const ROOM_SEMUA_PSIKOLOG = 'psikolog:semua';

export const EVENT = {
  SOS_BARU: 'sos:baru',
  SOS_DIPERBARUI: 'sos:diperbarui',
  SOS_ESKALASI: 'sos:eskalasi',
  SESI_KEDALUWARSA: 'sesi:kedaluwarsa',
  /** Booking konseling baru untuk psikolog ini (PBI-10). */
  BOOKING_BARU: 'booking:baru',
  /** Mahasiswa mengubah jadwal sesi (PBI-12); payload memuat `waktu_mulai_lama`. */
  BOOKING_DIUBAH: 'booking:diubah',
  /** Mahasiswa membatalkan sesi (PBI-12). */
  BOOKING_DIBATALKAN: 'booking:dibatalkan',
} as const;
