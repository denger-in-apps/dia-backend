import { UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'crypto';
import { SosKonfirmasiService } from './sos-konfirmasi.service';

describe('SosKonfirmasiService', () => {
  const mhs = '11111111-1111-4111-8111-111111111111';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // Konfigurasi sama dengan AuthModule: default audience = access token API.
  const jwt = new JwtService({
    privateKey,
    publicKey,
    signOptions: { algorithm: 'RS256', expiresIn: 900, issuer: 'dia-backend', audience: 'dia-api' },
    verifyOptions: { algorithms: ['RS256'], issuer: 'dia-backend', audience: 'dia-api' },
  });
  let redis: { status: string; set: jest.Mock };
  let service: SosKonfirmasiService;

  beforeEach(() => {
    process.env.SOS_JEDA_MINIMAL_MS = '0';
    redis = { status: 'ready', set: jest.fn().mockResolvedValue('OK') };
    service = new SosKonfirmasiService(jwt, redis as never);
  });

  afterAll(() => {
    delete process.env.SOS_JEDA_MINIMAL_MS;
  });

  const kode = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      return ((error as UnprocessableEntityException).getResponse() as { kode: string }).kode;
    }
    throw new Error('expected rejection');
  };

  it('issues a short-lived token bound to the student that verifies once', async () => {
    const { token_konfirmasi, berlaku_detik } = await service.terbitkan(mhs);
    expect(berlaku_detik).toBe(120);
    const { jti } = await service.verifikasi(mhs, token_konfirmasi);
    expect(await service.pakai(jti)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(`genta:konfirmasi:${jti}`, '1', 'EX', 180, 'NX');
  });

  it('cannot be used as an access token, and an access token cannot be used as confirmation', async () => {
    const { token_konfirmasi } = await service.terbitkan(mhs);
    await expect(jwt.verifyAsync(token_konfirmasi)).rejects.toThrow();

    const accessToken = await jwt.signAsync({ role: 'MAHASISWA', jti: 'x' }, { subject: mhs });
    expect(await kode(service.verifikasi(mhs, accessToken))).toBe('KONFIRMASI_TIDAK_VALID');
  });

  it('rejects a token issued to another student', async () => {
    const { token_konfirmasi } = await service.terbitkan('22222222-2222-4222-8222-222222222222');
    expect(await kode(service.verifikasi(mhs, token_konfirmasi))).toBe('KONFIRMASI_TIDAK_VALID');
  });

  it('rejects an expired or tampered token', async () => {
    const expired = await jwt.signAsync(
      { tujuan: 'GENTA_SOS_KONFIRMASI', diterbitkan_ms: Date.now() - 300_000 },
      { subject: mhs, audience: 'dia-genta-konfirmasi', expiresIn: -10, jwtid: 'j' },
    );
    expect(await kode(service.verifikasi(mhs, expired))).toBe('KONFIRMASI_TIDAK_VALID');

    const { token_konfirmasi } = await service.terbitkan(mhs);
    const tampered = token_konfirmasi.slice(0, -4) + 'AAAA';
    expect(await kode(service.verifikasi(mhs, tampered))).toBe('KONFIRMASI_TIDAK_VALID');
  });

  it('rejects confirmation sent faster than the minimum human delay', async () => {
    process.env.SOS_JEDA_MINIMAL_MS = '5000';
    const { token_konfirmasi } = await service.terbitkan(mhs);
    expect(await kode(service.verifikasi(mhs, token_konfirmasi))).toBe('KONFIRMASI_TERLALU_CEPAT');
  });

  it('reports reuse, but fails open when Redis is unavailable (safety feature)', async () => {
    redis.set.mockResolvedValueOnce(null);
    expect(await service.pakai('jti-1')).toBe(false);

    redis.set.mockRejectedValueOnce(new Error('redis down'));
    expect(await service.pakai('jti-2')).toBe(true);
  });
});
