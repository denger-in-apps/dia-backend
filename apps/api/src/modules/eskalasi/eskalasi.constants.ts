export const ESKALASI_QUEUE = 'genta-eskalasi';
export const JOB_ESKALASI_SOS = 'eskalasi-sos';

/** jobId deterministik: satu timer per SOS (BullMQ menolak id duplikat), tidak boleh memuat ':'. */
export const jobIdEskalasi = (idSos: string): string => `eskalasi-${idSos}`;

/** Penyebab eskalasi; dicatat pada log untuk penelusuran. */
export type SumberEskalasi = 'TIMER' | 'TANPA_PSIKOLOG' | 'SAPU';

/** Jeda ekstra sebelum sweeper DB mengambil alih timer yang hilang (Redis mati / job lenyap). */
export const SAPU_TOLERANSI_DETIK = 15;
