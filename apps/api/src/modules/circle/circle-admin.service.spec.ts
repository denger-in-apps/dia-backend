import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { CircleAdminService } from './circle-admin.service';

describe('CircleAdminService (SCRUM-264)', () => {
  const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
  const idCircle = '99999999-9999-4999-8999-999999999999';
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const idMhs = '11111111-1111-4111-8111-111111111111';
  let row: Record<string, unknown>;
  let psikologAktif: boolean;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: CircleAdminService;

  beforeEach(() => {
    row = { id_circle: idCircle, nama_circle: 'Pejuang Skripsi', kuota: 8, status: 'DIAJUKAN', id_kategori: 'k',
      nama_kategori: 'Akademik', jumlah_anggota: 6, id_psikolog: null, alasan_penolakan: null, diajukan_mahasiswa: true };
    psikologAktif = true;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM psikolog WHERE id_psikolog')) return { rows: psikologAktif ? [{}] : [], rowCount: psikologAktif ? 1 : 0 };
        if (sql.includes('FROM kategori_minat WHERE id_kategori')) return { rows: [{}], rowCount: 1 };
        if (sql.includes("SET status = 'AKTIF'") || sql.includes("SET status = 'DITOLAK'")) {
          return { rows: row.status === 'DIAJUKAN' ? [{ diajukan_oleh: idMhs, nama_circle: 'Pejuang Skripsi' }] : [] };
        }
        if (sql.includes('SELECT status FROM circle')) return { rows: [{ status: row.status }] };
        if (sql.includes('FROM circle c')) return { rows: [row] };
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [row] }) };
    audit = { catat: jest.fn() };
    service = new CircleAdminService(pool as unknown as Pool, audit as unknown as AuditService);
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  it('approves a proposal with an active companion, notifies the proposer and audits', async () => {
    await service.setujui(admin, idCircle, idPsi, {});
    expect(call("SET status = 'AKTIF'")![1]).toEqual([idCircle, idPsi, admin.id]);
    const notif = call('INSERT INTO notifikasi')!;
    expect(notif[1].slice(0, 2)).toEqual([idMhs, 'CIRCLE_DISETUJUI']);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'CIRCLE_SETUJUI', resourceId: idCircle }), client);
  });

  it('refuses inactive companions and non-pending circles', async () => {
    psikologAktif = false;
    await expect(service.setujui(admin, idCircle, idPsi, {})).rejects.toBeInstanceOf(UnprocessableEntityException);
    psikologAktif = true;
    row.status = 'AKTIF';
    const error = await service.setujui(admin, idCircle, idPsi, {}).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().kode).toBe('STATUS_CIRCLE_TIDAK_SESUAI');
    expect(audit.catat).not.toHaveBeenCalled();
  });

  it('rejects with a reason visible to the proposer', async () => {
    await service.tolak(admin, idCircle, 'Duplikat Circle yang sudah ada', {});
    expect(call("SET status = 'DITOLAK'")![1]).toEqual([idCircle, 'Duplikat Circle yang sudah ada', admin.id]);
    expect(call('INSERT INTO notifikasi')![1][1]).toBe('CIRCLE_DITOLAK');
  });

  it('never lowers the quota below the current member count', async () => {
    row.status = 'AKTIF';
    const error = await service.ubah(admin, idCircle, { kuota: 5 }, {}).catch((e) => e);
    expect(error.getResponse().kode).toBe('KUOTA_DI_BAWAH_ANGGOTA');
    await service.ubah(admin, idCircle, { kuota: 7, nama_circle: 'Baru' }, {});
    expect(call('UPDATE circle SET')![1]).toEqual([idCircle, 'Baru', 7]);
  });

  it('closes active circles only', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'DITUTUP'")) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT status FROM circle')) return { rows: [{ status: 'DITUTUP' }] };
      return { rows: [row] };
    });
    await expect(service.tutup(admin, idCircle, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not expose proposer or member identities to the admin', async () => {
    const daftar = await service.daftar({});
    expect(pool.query.mock.calls[0][0]).not.toMatch(/\bm\.nama\b|diajukan_oleh::text/);
    expect(daftar[0]).toMatchObject({ diajukan_mahasiswa: true, jumlah_anggota: 6 });
    expect(daftar[0]).not.toHaveProperty('anggota');
  });
});
