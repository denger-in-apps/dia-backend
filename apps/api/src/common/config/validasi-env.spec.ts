import { validasiEnv } from './validasi-env';

describe('validasiEnv (SCRUM-200)', () => {
  const dasar = {
    DATABASE_URL: 'postgres://u:p@db/x', JWT_PRIVATE_KEY_PATH: '/k', JWT_PUBLIC_KEY_PATH: '/p',
    ENCRYPTION_ACTIVE_KEY_ID: '1', CORS_ORIGINS: 'https://localhost',
  };

  it('accepts a minimal development configuration', () => {
    expect(() => validasiEnv({ ...dasar })).not.toThrow();
  });

  it('reports every problem at once', () => {
    let pesan = '';
    try {
      validasiEnv({
        DATABASE_URL: '', JWT_PUBLIC_KEY_PATH: '/p', ENCRYPTION_ACTIVE_KEY_ID: '1',
        CORS_ORIGINS: 'bukan url', SESI_DURASI_MENIT: '5', OIDC_ISSUER_URL: 'https://idp.example',
        PENGINGAT_OFFSET_MENIT: '1',
      });
    } catch (error) {
      pesan = (error as Error).message;
    }
    for (const bagian of ['DATABASE_URL wajib', 'JWT_PRIVATE_KEY_PATH wajib', 'CORS_ORIGINS memuat origin tidak valid',
      'SESI_DURASI_MENIT', 'OIDC_CLIENT_ID wajib', 'PENGINGAT_OFFSET_MENIT']) {
      expect(pesan).toContain(bagian);
    }
  });

  it('requires HTTPS URLs and frontend redirects in production', () => {
    const jalankan = () => validasiEnv({
      ...dasar, NODE_ENV: 'production', FRONTEND_LOGIN_SUCCESS_URL: 'http://app.example/',
    });
    expect(jalankan).toThrow('FRONTEND_LOGIN_SUCCESS_URL produksi wajib memakai HTTPS');
    expect(jalankan).toThrow('FRONTEND_LOGIN_FAILURE_URL wajib diisi');
  });

  it('does not leak the validated env into process.env', () => {
    const sebelum = process.env;
    validasiEnv({ ...dasar });
    expect(process.env).toBe(sebelum);
  });
});
