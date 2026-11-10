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
} as const;
