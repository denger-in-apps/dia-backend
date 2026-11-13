import { originDiizinkan } from './psikolog.gateway';

describe('originDiizinkan (handshake Socket.IO /psikolog)', () => {
  const sebelum = process.env.CORS_ORIGINS;
  beforeEach(() => { process.env.CORS_ORIGINS = 'https://127.0.0.1:3443, https://app.denger.in'; });
  afterAll(() => { process.env.CORS_ORIGINS = sebelum; });

  it('menerima origin terdaftar (spasi di konfigurasi diabaikan)', () => {
    expect(originDiizinkan('https://127.0.0.1:3443')).toBe(true);
    expect(originDiizinkan('https://app.denger.in')).toBe(true);
  });

  it('menolak origin browser lain, termasuk variasi skema/port', () => {
    expect(originDiizinkan('https://evil.example')).toBe(false);
    expect(originDiizinkan('http://127.0.0.1:3443')).toBe(false);
    expect(originDiizinkan('https://127.0.0.1:3444')).toBe(false);
    expect(originDiizinkan('null')).toBe(false);
  });

  it('mengizinkan klien tanpa header Origin (non-browser); token tetap wajib di middleware', () => {
    expect(originDiizinkan(undefined)).toBe(true);
  });
});
