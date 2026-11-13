import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';

/**
 * Provisioning akun Dosen Admin (SCRUM-208). Berbeda dengan `seed:dev-auth`, skrip ini
 * **boleh** dijalankan di produksi oleh operator yang memegang akses DB, karena tidak ada
 * jalur lain membuat admin pertama. Password sementara acak ditampilkan sekali; admin wajib
 * menggantinya (`wajib_ganti_password`) dan, di produksi, mendaftarkan MFA saat login pertama.
 *
 * Pemakaian:
 *   npm run admin:buat -- --np 198001012005011001 --nama "Dr. Siti" --email siti@kampus.ac.id [--prodi Psikologi]
 *   npm run admin:buat -- --email siti@kampus.ac.id --reset      # password sementara baru + aktifkan ulang
 * Di image produksi: node dist/database/seed/buat-admin.js --np ... --nama ... --email ...
 */
export interface InputAdmin {
  np?: string;
  nama?: string;
  email: string;
  prodi?: string;
  reset?: boolean;
}

export function parseArgs(argv: string[]): InputAdmin {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Argumen tidak dikenal: ${key}`);
    const name = key.slice(2);
    if (name === 'reset') {
      args.reset = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Nilai untuk --${name} wajib diisi`);
    args[name] = value.trim();
  }
  const allowed = ['np', 'nama', 'email', 'prodi', 'reset'];
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`Argumen tidak dikenal: ${unknown.map((k) => `--${k}`).join(', ')}`);
  const email = String(args.email ?? '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email wajib berupa alamat email valid');
  const input: InputAdmin = {
    email,
    np: args.np as string | undefined,
    nama: args.nama as string | undefined,
    prodi: args.prodi as string | undefined,
    reset: args.reset === true,
  };
  if (!input.reset && (!input.np || !input.nama)) throw new Error('--np dan --nama wajib untuk akun baru');
  return input;
}

export async function buatAdmin(pool: Pool, input: InputAdmin): Promise<{ id: string; password_sementara: string; dibuat: boolean }> {
  const password = randomBytes(18).toString('base64url');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  if (input.reset) {
    const result = await pool.query<{ id: string }>(
      `UPDATE dosen_admin SET password_hash = $2, wajib_ganti_password = true, aktif = true
       WHERE email = $1 RETURNING id_dosen::text AS id`,
      [input.email, hash],
    );
    if (!result.rows[0]) throw new Error(`Dosen admin ${input.email} tidak ditemukan`);
    // Sesi lama dicabut agar password lama tidak lagi berlaku lewat refresh token.
    await pool.query(
      `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now()) WHERE id_pengguna = $1 AND role = 'DOSEN_ADMIN'`,
      [result.rows[0].id],
    );
    return { id: result.rows[0].id, password_sementara: password, dibuat: false };
  }
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO dosen_admin (np, nama, email, prodi, password_hash, aktif, wajib_ganti_password)
       VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id_dosen::text AS id`,
      [input.np, input.nama, input.email, input.prodi ?? null, hash],
    );
    return { id: result.rows[0].id, password_sementara: password, dibuat: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new Error('Email atau nomor pegawai sudah terdaftar; gunakan --reset untuk password baru');
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL wajib diisi');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    const hasil = await buatAdmin(pool, input);
    console.log(`${hasil.dibuat ? 'Dosen admin dibuat' : 'Password dosen admin direset'}: ${input.email} (${hasil.id})`);
    console.log(`Password sementara (tampil sekali, serahkan lewat kanal aman): ${hasil.password_sementara}`);
    console.log('Admin wajib mengganti password saat login pertama; di produksi juga mendaftarkan MFA.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
