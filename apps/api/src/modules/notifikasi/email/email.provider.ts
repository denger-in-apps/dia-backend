export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface EmailKeluar {
  ke: string;
  subjek: string;
  teks: string;
  /** Stabil per pengingat sehingga retry tidak menggandakan email pada provider yang mendukungnya. */
  idempotencyKey: string;
}

/** Antarmuka email gateway (pengingat sesi PBI-14). Isi email tidak boleh memuat topik keluhan. */
export interface EmailProvider {
  kirim(email: EmailKeluar): Promise<{ providerMessageId: string | null }>;
}

/** Samarkan alamat untuk log, mis. `budi.santoso@kampus.ac.id` → `bu***@kampus.ac.id`. */
export function maskEmail(email: string): string {
  const [lokal, domain] = email.split('@');
  if (!domain) return '***';
  return `${lokal.slice(0, 2)}***@${domain}`;
}
