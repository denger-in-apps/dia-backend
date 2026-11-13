import { intEnv } from '../../common/domain/env';

/**
 * Offset pengingat (menit sebelum sesi), default H-24 jam dan H-1 jam (02-backend.md §9.4).
 * Format env: daftar dipisah koma, mis. `1440,60`.
 */
export function offsetPengingat(): number[] {
  const raw = process.env.PENGINGAT_OFFSET_MENIT?.trim();
  if (!raw) return [1440, 60];
  const values = raw.split(',').map((item) => Number(item.trim()));
  if (values.length === 0 || values.length > 5 || values.some((v) => !Number.isInteger(v) || v < 5 || v > 10080)) {
    throw new Error('PENGINGAT_OFFSET_MENIT harus 1–5 bilangan bulat 5–10080 dipisah koma');
  }
  return [...new Set(values)].sort((a, b) => b - a);
}

export const pengingatConfig = {
  /** Percobaan kirim email maksimal (use case alt 2.a: retry maks. 3 kali). */
  maksPercobaan: () => intEnv('PENGINGAT_MAKS_PERCOBAAN', 3, 1, 10),
  /** Jeda dasar retry (detik); percobaan ke-n menunggu dasar × 4^(n-1). */
  retryDasarDetik: () => intEnv('PENGINGAT_RETRY_DASAR_DETIK', 60, 1, 3600),
};

/** Klaim worker berlaku sekian detik; bila proses mati di tengah, baris diambil ulang setelahnya. */
export const LEASE_DETIK = 300;
export const BATCH_PENGINGAT = 50;
