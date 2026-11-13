export const ESKALASI_QUEUE = 'genta-eskalasi';
export const JOB_ESKALASI_SOS = 'eskalasi-sos';

/** jobId deterministik: satu timer per SOS (BullMQ menolak id duplikat), tidak boleh memuat ':'. */
export const jobIdEskalasi = (idSos: string): string => `eskalasi-${idSos}`;

/** Penyebab eskalasi; dicatat pada log untuk penelusuran. */
export type SumberEskalasi = 'TIMER' | 'TANPA_PSIKOLOG' | 'SAPU';

/** Jeda ekstra sebelum sweeper DB mengambil alih timer yang hilang (Redis mati / job lenyap). */
export const SAPU_TOLERANSI_DETIK = 15;

/** Klaim tindakan eskalasi dianggap mati setelah sekian detik (jauh di atas durasi kirim SMS ≈ 20 dtk). */
export const KLAIM_KEDALUWARSA_DETIK = 120;

/** Percobaan tindakan eskalasi (SMS/hotline) maksimal sebelum dicatat butuh penanganan manual. */
export const MAKS_PERCOBAAN_TINDAKAN = 5;
