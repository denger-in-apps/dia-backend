import { BadRequestException, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { AuditService } from '../../common/audit/audit.service';
import { RolesGuard } from '../../common/auth/roles.guard';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService, csvSel } from './audit-log.service';

const admin = TEST_USERS.DOSEN_ADMIN;
const row = {
  id_log: '42', waktu: new Date('2026-11-16T03:00:00Z'), aktor_id: '22222222-2222-4222-8222-222222222222', aktor_role: 'PSIKOLOG',
  aktor_nama: 'Psi A', aksi: 'SOS_LOKASI_READ', resource_type: 'log_sos', resource_id: 's1', hasil: 'SUKSES',
  ip: '10.0.0.1', user_agent: '=cmd|calc', metadata: { a: 1 },
};

describe('AuditLogService (SCRUM-277)', () => {
  let pool: { query: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: AuditLogService;

  beforeEach(() => {
    pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    audit = { catat: jest.fn() };
    service = new AuditLogService(pool as unknown as Pool, audit as unknown as AuditService);
  });

  it('filters with parameters, paginates by cursor, and audits the read itself', async () => {
    const hasil = await service.daftar(admin, {
      aksi: 'SOS_LOKASI_READ,CURHAT_READ', hasil: 'SUKSES', dari: '2026-11-01', sampai: '2026-11-16', sebelum: 100, limit: 1,
    }, { ip: '1.1.1.1' });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY a.id_log DESC');
    expect(params).toEqual([
      null, null, ['SOS_LOKASI_READ', 'CURHAT_READ'], null, null, 'SUKSES',
      '2026-11-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z', 100, 1,
    ]);
    expect(hasil.data[0]).toMatchObject({ id_log: 42, aktor: { role: 'PSIKOLOG', nama: 'Psi A' } });
    expect(hasil.berikutnya).toBe(42);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'AUDIT_LOG_READ', metadata: expect.objectContaining({ jumlah: 1, filter: expect.objectContaining({ hasil: 'SUKSES' }) }),
    }));
  });

  it('shows names only for staff actors (no join to mahasiswa)', async () => {
    await service.daftar(admin, {}, {});
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("CASE a.aktor_role WHEN 'PSIKOLOG' THEN p.nama WHEN 'DOSEN_ADMIN' THEN d.nama END");
    expect(sql).not.toContain('mahasiswa');
  });

  it('rejects an inverted time range', async () => {
    await expect(service.daftar(admin, { dari: '2026-11-10', sampai: '2026-11-01' }, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('exports CSV safely and audits the export', async () => {
    const { csv, jumlah } = await service.ekspor(admin, {}, {});
    const [header, baris] = csv.trim().split('\r\n');
    expect(header).toBe('id_log,waktu,aktor_id,aktor_role,aktor_nama,aksi,resource_type,resource_id,hasil,ip,user_agent,metadata');
    expect(baris).toContain("'=cmd|calc");
    expect(baris).toContain('"{""a"":1}"');
    expect(jumlah).toBe(1);
    expect(pool.query.mock.calls[0][1][9]).toBe(10_000);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'AUDIT_LOG_EKSPOR' }));
  });

  it.each([['=1+1', "'=1+1"], ['-2', "'-2"], ['@x', "'@x"], ['a,b', '"a,b"'], ['biasa', 'biasa']])('csvSel(%s)', (masuk, keluar) => {
    expect(csvSel(masuk)).toBe(keluar);
  });
});

describe('RolesGuard AKSES_DITOLAK (SCRUM-277)', () => {
  const buatContext = (req: Record<string, unknown>) => ({
    getHandler: jest.fn(), getClass: jest.fn(), switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

  it('records forbidden attempts by authenticated users without query strings, and still throws 403', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['DOSEN_ADMIN']) };
    const audit = { catat: jest.fn().mockResolvedValue(undefined) };
    const guard = new RolesGuard(reflector as unknown as Reflector, audit as unknown as AuditService);
    const req = { user: TEST_USERS.MAHASISWA, method: 'GET', originalUrl: '/api/v1/admin/audit-log?aksi=X', ip: '1.2.3.4', headers: { 'user-agent': 'ua' } };
    expect(() => guard.canActivate(buatContext(req))).toThrow(ForbiddenException);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aktor: TEST_USERS.MAHASISWA, aksi: 'AKSES_DITOLAK', resourceType: 'endpoint', resourceId: 'GET /api/v1/admin/audit-log',
      hasil: 'DITOLAK', ip: '1.2.3.4', metadata: { peran_dibutuhkan: ['DOSEN_ADMIN'] },
    }));
  });

  it('does not fail the request when auditing fails, and works without an audit service', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['DOSEN_ADMIN']) };
    const audit = { catat: jest.fn().mockRejectedValue(new Error('db down')) };
    const req = { user: TEST_USERS.PSIKOLOG, method: 'GET', url: '/x' };
    expect(() => new RolesGuard(reflector as unknown as Reflector, audit as unknown as AuditService).canActivate(buatContext(req)))
      .toThrow(ForbiddenException);
    expect(() => new RolesGuard(reflector as unknown as Reflector).canActivate(buatContext(req))).toThrow(ForbiddenException);
  });
});

describe('AuditLogController', () => {
  let app: INestApplication;
  let auditLog: Record<string, jest.Mock>;

  beforeEach(async () => {
    auditLog = {
      daftar: jest.fn().mockResolvedValue({ data: [], berikutnya: null }),
      daftarAksi: jest.fn().mockResolvedValue([]),
      ekspor: jest.fn().mockResolvedValue({ csv: 'id_log\r\n', jumlah: 0 }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditLogController],
      providers: [{ provide: AuditLogService, useValue: auditLog }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is only for Dosen Admin and has no write endpoints', async () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).get('/api/v1/admin/audit-log').set('Authorization', bearer(role)).expect(403);
    }
    await request(app.getHttpServer()).delete('/api/v1/admin/audit-log').set('Authorization', bearer('DOSEN_ADMIN')).expect(404);
  });

  it('validates filters and serves a CSV download', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/audit-log?aksi=drop table').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
    await request(app.getHttpServer()).get('/api/v1/admin/audit-log?limit=201').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
    await request(app.getHttpServer()).get('/api/v1/admin/audit-log?hasil=DITOLAK&sebelum=10').set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    expect(auditLog.daftar).toHaveBeenCalledWith(admin, { hasil: 'DITOLAK', sebelum: 10 }, expect.any(Object));

    const res = await request(app.getHttpServer()).get('/api/v1/admin/audit-log/ekspor').set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
