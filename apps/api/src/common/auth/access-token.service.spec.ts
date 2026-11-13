import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { AkademikService } from '../../modules/akademik/akademik.service';
import { GentaController } from '../../modules/genta/genta.controller';
import { AccessTokenService } from './access-token.service';
import { IZINKAN_SAAT_AKADEMIK_GANGGUAN } from './akademik-gangguan.decorator';

describe('AccessTokenService akses darurat (SCRUM-210)', () => {
  const sub = '11111111-1111-4111-8111-111111111111';
  let akademik: { wajibAktif: jest.Mock };
  let service: AccessTokenService;

  beforeEach(() => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub, role: 'MAHASISWA', jti: 'j', iat: 1, exp: 2 }) };
    const pool = {
      query: jest.fn().mockResolvedValue({
        // Status DB aktif, verifikasi terakhir sudah > 24 jam → perlu cek ulang ke akademik.
        rows: [{ nim: '2026001', status_aktif: true, terakhir_verifikasi_at: new Date(Date.now() - 100 * 3_600_000) }],
      }),
    };
    akademik = { wajibAktif: jest.fn().mockRejectedValue(new ServiceUnavailableException('down')) };
    service = new AccessTokenService(
      jwt as unknown as JwtService, pool as unknown as Pool, akademik as unknown as AkademikService,
    );
  });

  it('blocks regular endpoints while the academic API is down beyond the tolerance', async () => {
    await expect(service.verifikasi('t')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lets emergency endpoints through for students active in the DB', async () => {
    await expect(service.verifikasi('t', { izinkanSaatAkademikGangguan: true }))
      .resolves.toEqual({ user: { id: sub, role: 'MAHASISWA' }, exp: 2 });
  });

  it('never lets through students the academic system reports inactive', async () => {
    akademik.wajibAktif.mockRejectedValue(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    await expect(service.verifikasi('t', { izinkanSaatAkademikGangguan: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('marks the Genta (SOS) controller as an emergency endpoint', () => {
    expect(Reflect.getMetadata(IZINKAN_SAAT_AKADEMIK_GANGGUAN, GentaController)).toBe(true);
  });
});

describe('AccessTokenService password sementara (SCRUM-208)', () => {
  const build = (wajib: boolean) => new AccessTokenService(
    { verifyAsync: jest.fn().mockResolvedValue({ sub: 'p', role: 'PSIKOLOG', jti: 'j', iat: 1, exp: 2 }) } as never,
    { query: jest.fn().mockResolvedValue({ rows: [{ nim: null, status_aktif: true, wajib_ganti_password: wajib }] }) } as never,
    {} as never,
  );

  it('blocks staff with a temporary password except on explicitly allowed endpoints', async () => {
    const error = await build(true).verifikasi('t').catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().kode).toBe('PASSWORD_WAJIB_DIGANTI');
    await expect(build(true).verifikasi('t', { izinkanPasswordSementara: true })).resolves.toBeDefined();
    await expect(build(false).verifikasi('t')).resolves.toBeDefined();
  });
});
