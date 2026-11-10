export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface HasilKirimSms {
  providerMessageId: string | null;
}

/**
 * Antarmuka SMS gateway (02-backend.md §11). `idempotencyKey` stabil untuk satu
 * penerima pada satu SOS sehingga retry tidak menghasilkan SMS ganda di sisi provider
 * yang mendukungnya.
 */
export interface SmsProvider {
  kirim(nomor: string, teks: string, idempotencyKey: string): Promise<HasilKirimSms>;
}

/** Samarkan nomor untuk log, mis. 081234567890 → 0812*****890. Nomor utuh tidak pernah dicatat. */
export function maskNomor(nomor: string): string {
  const digits = nomor.replace(/[^\d+]/g, '');
  if (digits.length <= 7) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 7)}${digits.slice(-3)}`;
}
