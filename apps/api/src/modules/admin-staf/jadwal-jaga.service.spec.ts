import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { JadwalJagaService } from './jadwal-jaga.service';
import { StatusJagaSync } from './status-jaga.sync';

describe('JadwalJagaService', () => {
  const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const idJadwal = '99999999-9999-4999-8999-999999999999';
  const dto = { id_psikolog: idPsi, tanggal: '2026-12-01', jam_mulai: '08:00', jam_selesai: '16:00' };
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let psikolog: { status_akun: string; sudah_lewat: boolean } | null;
  let audit: { catat: jest.Mock };
  let service: JadwalJagaService;

  beforeEach(() => {
    psikolog = { status_akun: 'AKTIF', sudah_lewat: false };
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM psikolog WHERE id_psikolog')) return { rows: psikolog ? [psikolog] : [] };
        if (sql.includes('INSERT INTO jadwal_jaga') || sql.includes('UPDATE jadwal_jaga')) return { rows: [{ id: idJadwal }] };
        if (sql.includes('FROM jadwal_jaga j')) {
          return { rows: [{ id: idJadwal, id_psikolog: idPsi, tanggal: '2026-12-01', jam_mulai: '08:00', jam_selesai: '16:00' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn() };
    service = new JadwalJagaService(pool as unknown as Pool, audit as unknown as AuditService);
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  it('creates a shift for an active psychologist, set by the admin, and audits it', async () => {
    await service.buat(admin, dto, {});
    expect(call('INSERT INTO jadwal_jaga')![1]).toEqual(['2026-12-01', '08:00', '16:00', idPsi, admin.id]);
    expect(call('FROM psikolog WHERE id_psikolog')![1]).toEqual([idPsi, '2026-12-01', '16:00', 'Asia/Jakarta']);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'JADWAL_JAGA_BUAT', resourceId: idJadwal }), client);
  });

  it('allows a shift ending at 24:00', async () => {
    await expect(service.buat(admin, { ...dto, jam_mulai: '22:00', jam_selesai: '24:00' }, {})).resolves.toBeDefined();
  });

  it.each([
    [{ jam_mulai: '16:00', jam_selesai: '08:00' }, 'JAM_TIDAK_VALID'],
    [{ jam_mulai: '08:00', jam_selesai: '08:00' }, 'JAM_TIDAK_VALID'],
    [{ tanggal: '2026-02-30' }, 'TANGGAL_TIDAK_VALID'],
  ])('rejects invalid times %j', async (override, kode) => {
    const error = await service.buat(admin, { ...dto, ...override }, {}).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().kode).toBe(kode);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects inactive psychologists and shifts in the past', async () => {
    psikolog = { status_akun: 'MENUNGGU_VERIFIKASI', sudah_lewat: false };
    await expect(service.buat(admin, dto, {})).rejects.toBeInstanceOf(UnprocessableEntityException);
    psikolog = { status_akun: 'AKTIF', sudah_lewat: true };
    const error = await service.buat(admin, dto, {}).catch((e) => e);
    expect(error.getResponse().kode).toBe('JADWAL_SUDAH_LEWAT');
    psikolog = null;
    await expect(service.buat(admin, dto, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['23P01', '23505'])('maps DB overlap violation %s to 409 JADWAL_BENTROK', async (code) => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM psikolog WHERE id_psikolog')) return { rows: [psikolog] };
      if (sql.includes('INSERT INTO jadwal_jaga')) throw Object.assign(new Error('overlap'), { code });
      return { rows: [] };
    });
    const error = await service.buat(admin, dto, {}).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().kode).toBe('JADWAL_BENTROK');
  });

  it('merges partial updates with the current shift and re-validates', async () => {
    await service.ubah(admin, idJadwal, { jam_selesai: '20:00' }, {});
    expect(call('FOR UPDATE OF j')).toBeDefined();
    expect(call('UPDATE jadwal_jaga')![1]).toEqual([idJadwal, idPsi, '2026-12-01', '08:00', '20:00', admin.id]);

    await expect(service.ubah(admin, idJadwal, { jam_selesai: '07:00' }, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 when deleting an unknown shift', async () => {
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.hapus(admin, idJadwal, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists a bounded date range (default 14 days) and rejects inverted or oversized ranges', async () => {
    await service.daftar({ dari: '2026-12-01' });
    expect(pool.query.mock.calls[0][1]).toEqual(['2026-12-01', '2026-12-15', null]);

    await expect(service.daftar({ dari: '2026-12-10', sampai: '2026-12-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.daftar({ dari: '2026-01-01', sampai: '2026-12-31' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("scopes a psychologist's own schedule to their id", async () => {
    await service.milikSaya({ id: idPsi, role: 'PSIKOLOG' }, { dari: '2026-12-01', sampai: '2026-12-02' });
    expect(pool.query.mock.calls[0][1]).toEqual(['2026-12-01', '2026-12-02', idPsi]);
  });
});

describe('StatusJagaSync', () => {
  it('derives status_jaga from the current shift (WIB) and only updates changed rows', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 3 }) };
    const sync = new StatusJagaSync(pool as unknown as Pool);
    await expect(sync.sinkron()).resolves.toBe(3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("p2.status_akun = 'AKTIF' AND EXISTS");
    expect(sql).toContain('IS DISTINCT FROM target.jaga');
    expect(params).toEqual(['Asia/Jakarta']);

    pool.query.mockRejectedValue(new Error('db down'));
    await expect(sync.sinkron()).resolves.toBe(0);
  });
});
