import { HttpException } from '@nestjs/common';
import { LockoutLoginService } from './lockout-login.service';

describe('LockoutLoginService (SCRUM-208)', () => {
  let redis: { status: string; ttl: jest.Mock; set: jest.Mock; del: jest.Mock; multi: jest.Mock };
  let jumlah: number;
  let service: LockoutLoginService;

  beforeEach(() => {
    jumlah = 0;
    const tx = {
      incr: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => [[null, ++jumlah], [null, 1]]),
    };
    redis = {
      status: 'ready',
      ttl: jest.fn().mockResolvedValue(-2),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      multi: jest.fn(() => tx),
    };
    service = new LockoutLoginService(redis as never);
  });

  it('locks progressively: 1 minute at 5 failures, 15 minutes at 10', async () => {
    for (let i = 0; i < 4; i++) await service.catatGagal('PSIKOLOG', 'a@b.id');
    expect(redis.set).not.toHaveBeenCalled();
    await service.catatGagal('PSIKOLOG', 'a@b.id');
    expect(redis.set).toHaveBeenLastCalledWith(expect.stringMatching(/^auth:login:kunci:/), '1', 'EX', 60);
    for (let i = 0; i < 5; i++) await service.catatGagal('PSIKOLOG', 'a@b.id');
    expect(redis.set).toHaveBeenLastCalledWith(expect.any(String), '1', 'EX', 900);
  });

  it('keys by hashed role+email (case-insensitive), never the plain email', async () => {
    await service.catatGagal('DOSEN_ADMIN', 'Siti@Kampus.ac.id');
    const kunciA = redis.multi.mock.results[0].value.incr.mock.calls[0][0];
    await service.catatGagal('DOSEN_ADMIN', 'siti@kampus.ac.id ');
    expect(redis.multi.mock.results[1].value.incr.mock.calls[1][0]).toBe(kunciA);
    expect(kunciA).not.toContain('siti');
  });

  it('rejects locked accounts with 429 and the remaining seconds', async () => {
    redis.ttl.mockResolvedValue(42);
    const error = await service.pastikanTidakTerkunci('PSIKOLOG', 'a@b.id').catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ kode: 'AKUN_TERKUNCI_SEMENTARA', detail: { coba_lagi_detik: 42 } });
  });

  it('fails open when Redis is down (IP throttling still applies)', async () => {
    redis.ttl.mockRejectedValue(new Error('down'));
    await expect(service.pastikanTidakTerkunci('PSIKOLOG', 'a@b.id')).resolves.toBeUndefined();
    redis.multi.mockImplementation(() => { throw new Error('down'); });
    await expect(service.catatGagal('PSIKOLOG', 'a@b.id')).resolves.toBe(0);
  });
});
