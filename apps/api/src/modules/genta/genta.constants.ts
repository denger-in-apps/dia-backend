import { PrioritasSos } from '../../common/domain/sos';

/**
 * Pilihan "konfirmasi singkat" FR-MHS-03. Prioritas ditentukan server dari
 * pilihan ini (klien tidak pernah mengirim prioritas).
 */
export const SITUASI_SOS = {
  INGIN_MENYAKITI_DIRI: { label: 'Saya ingin menyakiti diri sendiri', prioritas: 'KRITIS', kritis: true },
  DALAM_BAHAYA: { label: 'Saya dalam bahaya / terancam orang lain', prioritas: 'KRITIS', kritis: true },
  SERANGAN_PANIK: { label: 'Saya mengalami serangan panik', prioritas: 'TINGGI', kritis: false },
  BUTUH_PENDAMPINGAN: { label: 'Saya butuh didampingi sekarang', prioritas: 'TINGGI', kritis: false },
  LAINNYA: { label: 'Keadaan darurat lainnya', prioritas: 'SEDANG', kritis: false },
} as const satisfies Record<string, { label: string; prioritas: PrioritasSos; kritis: boolean }>;

export type SituasiSos = keyof typeof SITUASI_SOS;
export const KODE_SITUASI_SOS = Object.keys(SITUASI_SOS) as SituasiSos[];

const URUTAN_PRIORITAS: PrioritasSos[] = ['RENDAH', 'SEDANG', 'TINGGI', 'KRITIS'];

/**
 * Prioritas akhir. Akun dengan riwayat penyalahgunaan turun satu tingkat, tetapi
 * situasi kritis (menyakiti diri / dalam bahaya) tidak pernah di bawah TINGGI:
 * menurunkan prioritas tidak boleh membuat orang yang benar-benar dalam bahaya terabaikan.
 */
export function tentukanPrioritas(situasi: SituasiSos, perluVerifikasi: boolean): PrioritasSos {
  const dasar = SITUASI_SOS[situasi].prioritas;
  if (!perluVerifikasi) return dasar;
  const turun = URUTAN_PRIORITAS[Math.max(0, URUTAN_PRIORITAS.indexOf(dasar) - 1)];
  if (SITUASI_SOS[situasi].kritis && URUTAN_PRIORITAS.indexOf(turun) < URUTAN_PRIORITAS.indexOf('TINGGI')) {
    return 'TINGGI';
  }
  return turun;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} harus bilangan bulat antara ${min} dan ${max}`);
  }
  return value;
}

/**
 * Parameter teknis langkah konfirmasi (env). Ambang anti-penyalahgunaan (SOS per jam,
 * laporan tidak valid, pembatalan) diatur Dosen Admin di `konfigurasi_sos` (SCRUM-236).
 */
export const gentaConfig = {
  /** Masa berlaku token konfirmasi (detik). */
  konfirmasiTtlDetik: () => intEnv('SOS_KONFIRMASI_TTL_DETIK', 120, 30, 600),
  /** Jeda minimal antara meminta konfirmasi dan mengirim SOS (ms) — menahan klik otomatis/skrip. */
  jedaMinimalMs: () => intEnv('SOS_JEDA_MINIMAL_MS', 800, 0, 10_000),
};
