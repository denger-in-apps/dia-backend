/** Nilai enum PostgreSQL `status_sos`. */
export type StatusSos = 'BARU' | 'DIAMBIL' | 'DITANGANI' | 'ESKALASI' | 'SELESAI';

/** Nilai enum PostgreSQL `prioritas_sos`, urut naik. */
export type PrioritasSos = 'RENDAH' | 'SEDANG' | 'TINGGI' | 'KRITIS';

/** SOS dianggap masih berjalan (belum selesai) pada status berikut. */
export const STATUS_SOS_AKTIF: readonly StatusSos[] = ['BARU', 'DIAMBIL', 'DITANGANI', 'ESKALASI'];

/** Literal SQL untuk dipakai di query/indeks; nilainya konstan, bukan input pengguna. */
export const SQL_STATUS_SOS_AKTIF = `('BARU', 'DIAMBIL', 'DITANGANI', 'ESKALASI')`;
