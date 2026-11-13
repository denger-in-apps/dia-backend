/**
 * Membaca env bilangan bulat dengan rentang tervalidasi. Nilai di luar rentang
 * membuat aplikasi gagal (bukan diam-diam memakai default) agar salah konfigurasi terlihat.
 */
export function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} harus bilangan bulat antara ${min} dan ${max}`);
  }
  return value;
}
