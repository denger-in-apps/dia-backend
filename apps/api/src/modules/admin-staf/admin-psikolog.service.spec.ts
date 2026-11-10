import { ConflictException, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { PsikologGateway } from '../realtime/psikolog.gateway';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { AdminPsikologService } from './admin-psikolog.service';

describe('AdminPsikologService', () => {
  const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const detailRow = { id: idPsi, nama: 'Psi', email: 'psi@kampus.ac.id', status_akun: 'MENUNGGU_VERIFIKASI', kasus_aktif: 0 };
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let notifikasi: { sosDiperbarui: jest.Mock; sosEskalasi: jest.Mock };
  let gateway: { putuskanPsikolog: jest.Mock };
  let service: AdminPsikologService;

  beforeEach(() => {
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM psikolog p WHERE p.id_psikolog')) return { rows: [detailRow] };
        if (sql.includes('INSERT INTO psikolog')) return { rows: [{ id: idPsi }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = { query: jest.fn().mockResolvedValue({ rows: [detailRow] }), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn() };
    notifikasi = { sosDiperbarui: jest.fn(), sosEskalasi: jest.fn().mockResolvedValue(2) };
    gateway = { putuskanPsikolog: jest.fn() };
    service = new AdminPsikologService(
      pool as unknown as Pool, audit as unknown as AuditService,
      notifikasi as unknown as SosNotifikasiService, gateway as unknown as PsikologGateway,
    );
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  it('creates a pending account with an argon2id-hashed temporary password shown once', async () => {
    const result = await service.buat(admin, { nama: 'Psi', email: 'psi@kampus.ac.id' }, {});

    expect(result.password_sementara.length).toBeGreaterThanOrEqual(22);
    const [sql, params] = call('INSERT INTO psikolog')!;
    expect(sql).toContain("'MENUNGGU_VERIFIKASI', true");
    expect(params[2]).not.toBe(result.password_sementara);
    expect(params[2]).toMatch(/^\$argon2id\$/);
    await expect(argon2.verify(params[2], result.password_sementara)).resolves.toBe(true);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'AKUN_PSIKOLOG_BUAT', resourceId: idPsi }), client);
  });

  it('maps a duplicate email to 409', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO psikolog')) throw Object.assign(new Error('dup'), { code: '23505' });
      return { rows: [] };
    });
    await expect(service.buat(admin, { nama: 'Psi', email: 'x@y.z' }, {})).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('activates a pending account and records the verifying admin', async () => {
    await service.aktifkan(admin, idPsi, {});
    const [sql, params] = call("SET status_akun = 'AKTIF'")!;
    expect(sql).toContain('diverifikasi_oleh = $2, diverifikasi_at = now()');
    expect(params).toEqual([idPsi, admin.id]);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'AKUN_PSIKOLOG_AKTIFKAN' }), client);
  });

  it('on deactivation re-queues held SOS cases as ESKALASI, removes future shifts, revokes sessions and disconnects sockets', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status_akun = 'NONAKTIF'")) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE log_sos')) {
        return {
          rowCount: 1,
          rows: [{ id_sos: 'sos-1', prioritas: 'KRITIS', situasi: 'DALAM_BAHAYA', lokasi_izin: true, perlu_verifikasi: false, waktu_kejadian: new Date() }],
        };
      }
      if (sql.includes('DELETE FROM jadwal_jaga')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    });

    const result = await service.nonaktifkan(admin, idPsi, {});

    expect(result).toMatchObject({ kasus_dikembalikan: 1, jadwal_dihapus: 2 });
    const [sosSql, sosParams] = call('UPDATE log_sos')!;
    expect(sosSql).toContain("SET status_penanganan = 'ESKALASI', id_psikolog = NULL");
    expect(sosSql).toContain("status_penanganan IN ('DIAMBIL', 'DITANGANI')");
    expect(sosParams).toEqual([idPsi]);
    expect(call('DELETE FROM jadwal_jaga')![1]).toEqual([idPsi, 'Asia/Jakarta']);
    expect(call('UPDATE refresh_token')![1]).toEqual([idPsi]);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'AKUN_PSIKOLOG_NONAKTIFKAN', metadata: { kasus_dikembalikan: 1, jadwal_dihapus: 2 },
    }), client);
    expect(gateway.putuskanPsikolog).toHaveBeenCalledWith(idPsi);
    expect(notifikasi.sosDiperbarui).toHaveBeenCalledWith({ id_sos: 'sos-1', status_penanganan: 'ESKALASI', id_psikolog: null });
    expect(notifikasi.sosEskalasi).toHaveBeenCalledWith(expect.objectContaining({ id_sos: 'sos-1', sumber: 'PENANGAN_NONAKTIF' }));
    const commitOrder = client.query.mock.invocationCallOrder[client.query.mock.calls.findIndex(([s]) => s === 'COMMIT')];
    expect(notifikasi.sosEskalasi.mock.invocationCallOrder[0]).toBeGreaterThan(commitOrder);
  });

  it('is a no-op when the account is already inactive, and 404 when unknown', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status_akun = 'NONAKTIF'")) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM psikolog p WHERE')) return { rows: [detailRow] };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.nonaktifkan(admin, idPsi, {})).resolves.toMatchObject({ kasus_dikembalikan: 0 });
    expect(call('UPDATE log_sos')).toBeUndefined();
    expect(gateway.putuskanPsikolog).not.toHaveBeenCalled();

    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.nonaktifkan(admin, idPsi, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resets the password to a new temporary one and revokes sessions', async () => {
    const { password_sementara } = await service.resetPassword(admin, idPsi, {});
    const [sql, params] = call('SET password_hash = $2')!;
    expect(sql).toContain('wajib_ganti_password = true');
    await expect(argon2.verify(params[1], password_sementara)).resolves.toBe(true);
    expect(call('UPDATE refresh_token')).toBeDefined();
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'AKUN_PSIKOLOG_RESET_PASSWORD' }), client);
  });

  it('escapes LIKE wildcards in the search term', async () => {
    await service.daftar({ status: 'AKTIF', q: '100%_a' });
    expect(pool.query.mock.calls[0][1]).toEqual(['AKTIF', '100\\%\\_a']);
  });
});
