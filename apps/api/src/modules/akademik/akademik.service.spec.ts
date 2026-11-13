import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { AkademikService, SIRKUIT_TERBUKA_MS } from './akademik.service';
import { AkademikClient } from './akademik.types';

describe('AkademikService (SCRUM-210)', () => {
  const nim = '2026001';
  const jam = 3_600_000;
  let client: { cekStatus: jest.Mock };
  let pool: { query: jest.Mock };
  let redis: { status: string; get: jest.Mock; set: jest.Mock };
  let dbRow: { status_aktif: boolean; terakhir_verifikasi_at: Date | null } | null;
  let service: AkademikService;

  beforeEach(() => {
    jest.useRealTimers();
    delete process.env.AKADEMIK_TOLERANSI_GANGGUAN_JAM;
    dbRow = { status_aktif: true, terakhir_verifikasi_at: new Date(Date.now() - 30 * jam) };
    client = { cekStatus: jest.fn().mockRejectedValue(new ServiceUnavailableException('down')) };
    pool = {
      query: jest.fn(async (sql: string) => (sql.includes('SELECT status_aktif') ? { rows: dbRow ? [dbRow] : [] } : { rows: [] })),
    };
    redis = { status: 'ready', get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    service = new AkademikService(client as unknown as AkademikClient, pool as unknown as Pool, redis as never);
  });

  it('accepts an active account verified 30 hours ago during an outage (beyond the 24h re-verify interval)', async () => {
    await expect(service.verifikasi(nim)).resolves.toEqual({ aktif: true, sumber: 'cache' });
  });

  it('rejects with 503 once the tolerance window (default 72h) is exceeded, and is configurable', async () => {
    dbRow = { status_aktif: true, terakhir_verifikasi_at: new Date(Date.now() - 73 * jam) };
    await expect(service.verifikasi(nim)).rejects.toBeInstanceOf(ServiceUnavailableException);

    process.env.AKADEMIK_TOLERANSI_GANGGUAN_JAM = '96';
    await expect(service.verifikasi(nim)).resolves.toEqual({ aktif: true, sumber: 'cache' });
  });

  it('keeps inactive accounts inactive and fails closed for never-verified accounts', async () => {
    dbRow = { status_aktif: false, terakhir_verifikasi_at: new Date() };
    await expect(service.wajibAktif(nim)).rejects.toBeInstanceOf(ForbiddenException);
    dbRow = null;
    await expect(service.verifikasi(nim)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('opens a circuit after a failure so later requests skip the 3s API timeout', async () => {
    await service.verifikasi(nim);
    await service.verifikasi(nim);
    expect(client.cekStatus).toHaveBeenCalledTimes(1);

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + SIRKUIT_TERBUKA_MS + 1);
    client.cekStatus.mockResolvedValue(true);
    await expect(service.verifikasi(nim)).resolves.toEqual({ aktif: true, sumber: 'api' });
    expect(client.cekStatus).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('persists and caches a successful API answer', async () => {
    client.cekStatus.mockResolvedValue(false);
    await expect(service.verifikasi(nim)).resolves.toEqual({ aktif: false, sumber: 'api' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('terakhir_verifikasi_at = now()'), [nim, false]);
    expect(redis.set).toHaveBeenCalledWith(`akademik:${nim}`, 'tidak_aktif', 'EX', 86400);
  });
});

describe('AkademikService.hapusCache (SCRUM-213, hapus akun mahasiswa)', () => {
  const buat = (del: jest.Mock) => new AkademikService(
    { cekStatus: jest.fn() } as unknown as AkademikClient,
    { query: jest.fn() } as unknown as Pool,
    { status: 'ready', get: jest.fn(), set: jest.fn(), del } as never,
  );

  it('menghapus key akademik:{nim} yang ada', async () => {
    const del = jest.fn().mockResolvedValue(1);
    await expect(buat(del).hapusCache('1302210001')).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith('akademik:1302210001');
  });

  it('mengembalikan false bila key tidak ada', async () => {
    await expect(buat(jest.fn().mockResolvedValue(0)).hapusCache('1302210099')).resolves.toBe(false);
  });

  it('tidak melempar error bila Redis gagal (best-effort)', async () => {
    await expect(buat(jest.fn().mockRejectedValue(new Error('redis down'))).hapusCache('1302210001')).resolves.toBe(false);
  });
});
