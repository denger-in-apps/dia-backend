import { intEnv } from '../../common/domain/env';

export type StatusCircle = 'DIAJUKAN' | 'AKTIF' | 'DITOLAK' | 'DITUTUP';

export const circleConfig = {
  /** Maksimal Circle yang diikuti seorang mahasiswa sekaligus. */
  maksKeanggotaan: () => intEnv('CIRCLE_MAKS_PER_MAHASISWA', 5, 1, 50),
  /** Maksimal pengajuan Circle berstatus DIAJUKAN per mahasiswa. */
  maksPengajuan: () => intEnv('CIRCLE_MAKS_PENGAJUAN', 2, 1, 10),
  /** Maksimal pesan per pengirim per menit di satu Circle (anti-banjir). */
  maksPesanPerMenit: () => intEnv('CIRCLE_MAKS_PESAN_PER_MENIT', 20, 1, 200),
};

/** Kuota Circle 5–8 (CHECK `circle.kuota`). */
export const KUOTA_MIN = 5;
export const KUOTA_MAKS = 8;

/**
 * Nama pengirim pesan untuk anggota: alias bila anonim, nama tampilan bila tidak, dan
 * "Pendamping (nama)" untuk psikolog. Alias `m`=mahasiswa, `k`=keanggotaan, `p`=psikolog.
 */
export const SQL_NAMA_PENGIRIM = `CASE
  WHEN cp.id_psikolog IS NOT NULL THEN 'Pendamping (' || p.nama || ')'
  WHEN k.status_anonim THEN k.alias_anonim
  ELSE COALESCE(m.nama_tampilan, m.nama)
END`;
