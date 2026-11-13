import { intEnv } from '../../common/domain/env';

/** Namespace Socket.IO ruang sesi. Klien: `io('<origin>/sesi', { auth: { token } })`. */
export const NAMESPACE_SESI = '/sesi';

export const roomSesi = (idSesi: string): string => `sesi:${idSesi}`;

export const EVENT_SESI = {
  /** klien → server: `{ id_sesi }`, ack `{ ok, kode? }`. */
  GABUNG: 'sesi:gabung',
  /** klien → server: `{ id_sesi, ciphertext, nonce }`, ack `{ ok, pesan? }`. */
  KIRIM_PESAN: 'pesan:kirim',
  /** server → room: pesan terenkripsi baru. */
  PESAN_BARU: 'pesan:baru',
  /** klien ↔ klien via server: signaling WebRTC (offer/answer/ICE) untuk sesi SUARA; tidak disimpan. */
  SINYAL_RTC: 'rtc:sinyal',
  /** server → room: status sesi berubah (mis. psikolog memulai/mengakhiri sesi). */
  STATUS: 'sesi:status',
  /** server → klien: access token kedaluwarsa; sambung ulang dengan token baru. */
  TOKEN_KEDALUWARSA: 'token:kedaluwarsa',
} as const;

/** Batas ukuran payload signaling WebRTC (karakter JSON). */
export const MAKS_SINYAL_RTC = 16_000;

export const sesiConfig = {
  /** Psikolog boleh memulai sesi sekian menit sebelum jadwal. */
  mulaiLebihAwalMenit: () => intEnv('SESI_MULAI_LEBIH_AWAL_MENIT', 10, 0, 60),
  /** Pesan per pengguna per 10 detik di satu socket (anti-banjir). */
  maksPesanPer10Detik: () => intEnv('SESI_MAKS_PESAN_PER_10_DETIK', 30, 5, 200),
};
