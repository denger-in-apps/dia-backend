import { intEnv } from '../domain/env';
import { zonaWaktuJadwal } from '../domain/zona-waktu';
import { toleransiGangguanJam } from '../../modules/akademik/akademik.service';
import { bookingConfig } from '../../modules/booking/booking.constants';
import { gentaConfig } from '../../modules/genta/genta.constants';
import { offsetPengingat, pengingatConfig } from '../../modules/notifikasi/pengingat.constants';
import { sesiConfig } from '../../modules/sesi/sesi.constants';

type Env = NodeJS.ProcessEnv;

function wajib(env: Env, nama: string, galat: string[]): void {
  if (!env[nama]?.trim()) galat.push(`${nama} wajib diisi`);
}

function url(env: Env, nama: string, galat: string[], wajibHttpsDiProduksi = true): void {
  const value = env[nama]?.trim();
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (wajibHttpsDiProduksi && env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      galat.push(`${nama} produksi wajib memakai HTTPS`);
    }
  } catch {
    galat.push(`${nama} bukan URL yang valid`);
  }
}

/**
 * Validasi konfigurasi saat boot (02-backend.md §4): aplikasi gagal start dengan daftar
 * lengkap kesalahan, bukan gagal di tengah request pertama yang kebetulan memakai nilai itu.
 * Getter konfigurasi modul dipanggil di sini sehingga rentang yang ditegakkan sama persis.
 */
export function validasiEnv(env: Env = process.env): void {
  const galat: string[] = [];
  const produksi = env.NODE_ENV === 'production';

  for (const nama of ['DATABASE_URL', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'ENCRYPTION_ACTIVE_KEY_ID']) {
    wajib(env, nama, galat);
  }
  if (produksi) {
    for (const nama of ['CORS_ORIGINS', 'FRONTEND_LOGIN_SUCCESS_URL', 'FRONTEND_LOGIN_FAILURE_URL']) wajib(env, nama, galat);
  }
  for (const origin of (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    try {
      new URL(origin);
    } catch {
      galat.push(`CORS_ORIGINS memuat origin tidak valid: ${origin}`);
    }
  }
  for (const nama of ['FRONTEND_LOGIN_SUCCESS_URL', 'FRONTEND_LOGIN_FAILURE_URL', 'AKADEMIK_STATUS_URL',
    'SMS_GATEWAY_URL', 'EMAIL_GATEWAY_URL', 'OIDC_ISSUER_URL', 'OIDC_REDIRECT_URI']) {
    url(env, nama, galat);
  }
  // OIDC boleh belum dikonfigurasi (menunggu IT kampus), tetapi bila issuer diisi harus lengkap.
  if (env.OIDC_ISSUER_URL?.trim()) {
    for (const nama of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']) wajib(env, nama, galat);
  }

  const getter: [string, () => unknown][] = [
    ['REFRESH_TOKEN_TTL_SECONDS', () => intEnv('REFRESH_TOKEN_TTL_SECONDS', 604800, 60, 30 * 24 * 60 * 60)],
    ['REFRESH_REUSE_GRACE_SECONDS', () => intEnv('REFRESH_REUSE_GRACE_SECONDS', 10, 0, 60)],
    ['JADWAL_ZONA_WAKTU', zonaWaktuJadwal],
    ['AKADEMIK_TOLERANSI_GANGGUAN_JAM', toleransiGangguanJam],
    ['SOS_*', () => [gentaConfig.konfirmasiTtlDetik(), gentaConfig.jedaMinimalMs()]],
    ['BOOKING_*/SESI_*', () => Object.values(bookingConfig).map((f) => f())],
    ['SESI_*', () => Object.values(sesiConfig).map((f) => f())],
    ['PENGINGAT_*', () => [offsetPengingat(), ...Object.values(pengingatConfig).map((f) => f())]],
  ];
  const sebelumnya = process.env;
  process.env = env;
  try {
    for (const [nama, f] of getter) {
      try {
        f();
      } catch (error) {
        galat.push((error as Error).message || `${nama} tidak valid`);
      }
    }
  } finally {
    process.env = sebelumnya;
  }

  if (galat.length) {
    throw new Error(`Konfigurasi tidak valid:\n- ${galat.join('\n- ')}`);
  }
}
