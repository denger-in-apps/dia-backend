import * as argon2 from 'argon2';
import { Pool } from 'pg';

const TEST_PASSWORD_MIN_LENGTH = 12;

async function run(): Promise<void> {
  if (process.env.NODE_ENV !== 'development' || process.env.DEV_AUTH_SEED !== 'true') {
    throw new Error('Seeder akun uji hanya berjalan dengan NODE_ENV=development dan DEV_AUTH_SEED=true');
  }

  const connectionString = process.env.DATABASE_URL;
  const password = process.env.DEV_AUTH_PASSWORD;
  if (!connectionString) throw new Error('DATABASE_URL wajib diisi');
  if (!password || password.length < TEST_PASSWORD_MIN_LENGTH) {
    throw new Error(`DEV_AUTH_PASSWORD wajib diisi dan minimal ${TEST_PASSWORD_MIN_LENGTH} karakter`);
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const adminResult = await client.query<{ id: string }>(
      `INSERT INTO dosen_admin (np, nama, email, password_hash, aktif)
       VALUES ('DEV-DOSEN-ADMIN-001', 'Admin Uji', 'admin.test@denger.local', $1, true)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         aktif = true,
         updated_at = now()
       RETURNING id_dosen::text AS id`,
      [passwordHash],
    );
    const adminId = adminResult.rows[0]?.id;
    if (!adminId) throw new Error('Akun Admin Uji gagal dibuat');

    await client.query(
      `INSERT INTO psikolog
         (nama, email, password_hash, status_akun, diverifikasi_oleh, diverifikasi_at)
       VALUES ('Psikolog Uji', 'psikolog.test@denger.local', $1, 'AKTIF', $2, now())
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         status_akun = 'AKTIF',
         diverifikasi_oleh = EXCLUDED.diverifikasi_oleh,
         diverifikasi_at = now(),
         updated_at = now()`,
      [passwordHash, adminId],
    );

    await client.query(
      `INSERT INTO mahasiswa (nim, nama, email, status_aktif)
       VALUES ('TEST-DEV-0001', 'Mahasiswa Uji', 'mahasiswa.test@denger.local', true)
       ON CONFLICT (nim) DO UPDATE SET
         status_aktif = true,
         sso_subject = NULL,
         deleted_at = NULL,
         updated_at = now()`,
    );

    await client.query('COMMIT');
    console.log('Akun uji development siap:');
    console.log('  DOSEN_ADMIN: admin.test@denger.local');
    console.log('  PSIKOLOG: psikolog.test@denger.local');
    console.log('  MAHASISWA: TEST-DEV-0001 / mahasiswa.test@denger.local (aktif; login tetap lewat OIDC)');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
