import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { AuditService } from '../../common/audit/audit.service';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { SumberDayaAdminController, SumberDayaController } from './sumber-daya.controller';
import { SumberDayaService } from './sumber-daya.service';

describe('SumberDayaService (SCRUM-270)', () => {
  const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: SumberDayaService;

  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue({ rows: [{ id_sumber: id }], rowCount: 1 }), release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    audit = { catat: jest.fn() };
    service = new SumberDayaService(pool as unknown as Pool, audit as unknown as AuditService);
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment))!;

  it('shows only active entries publicly, hotlines first', async () => {
    await service.daftarPublik('HOTLINE_NASIONAL');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE aktif AND');
    expect(sql).toContain("WHEN 'HOTLINE_NASIONAL' THEN 0");
    expect(params).toEqual(['HOTLINE_NASIONAL']);
    await expect(service.detailPublik(id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates entries owned by the admin and audits every change', async () => {
    await service.buat(admin, { nama: 'Healing119.id', kategori: 'HOTLINE_NASIONAL', kontak: '119 ext. 8' }, {});
    expect(call('INSERT INTO sumber_daya')[1]).toEqual(['Healing119.id', 'HOTLINE_NASIONAL', '119 ext. 8', null, true, admin.id]);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SUMBER_DAYA_BUAT', resourceId: id }), client);

    await service.ubah(admin, id, { aktif: false }, {});
    const [sql, params] = call('UPDATE sumber_daya');
    expect(sql).toContain('aktif = $3, id_dosen = $2');
    expect(params).toEqual([id, admin.id, false]);
    expect(audit.catat).toHaveBeenLastCalledWith(expect.objectContaining({ aksi: 'SUMBER_DAYA_UBAH', metadata: { field: ['aktif'] } }), client);
  });

  it('returns 404 for unknown entries', async () => {
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.ubah(admin, id, { nama: 'X Y' }, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.hapus(admin, id, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.catat).not.toHaveBeenCalled();
  });
});

describe('SumberDaya controllers', () => {
  let app: INestApplication;
  let sumberDaya: Record<string, jest.Mock>;

  beforeEach(async () => {
    sumberDaya = Object.fromEntries(
      ['daftarPublik', 'detailPublik', 'daftarAdmin', 'buat', 'ubah', 'hapus'].map((n) => [n, jest.fn().mockResolvedValue([])]),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [SumberDayaController, SumberDayaAdminController],
      providers: [{ provide: SumberDayaService, useValue: sumberDaya }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('serves the directory without login (FR-MHS-02: tetap terbuka)', async () => {
    await request(app.getHttpServer()).get('/api/v1/sumber-daya?kategori=HOTLINE_NASIONAL').expect(200);
    expect(sumberDaya.daftarPublik).toHaveBeenCalledWith('HOTLINE_NASIONAL');
    await request(app.getHttpServer()).get('/api/v1/sumber-daya?kategori=LAINNYA').expect(400);
  });

  it('restricts management to Dosen Admin with validated bodies', async () => {
    const body = { nama: 'Klinik Kampus', kategori: 'UNIT_KESEHATAN_KAMPUS', kontak: '(022) 1234-5678' };
    await request(app.getHttpServer()).post('/api/v1/admin/sumber-daya').send(body).expect(401);
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).post('/api/v1/admin/sumber-daya').set('Authorization', bearer(role)).send(body).expect(403);
    }
    await request(app.getHttpServer()).post('/api/v1/admin/sumber-daya').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ ...body, kategori: 'APOTEK' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/admin/sumber-daya').set('Authorization', bearer('DOSEN_ADMIN')).send(body).expect(201);
    expect(sumberDaya.buat).toHaveBeenCalledWith(TEST_USERS.DOSEN_ADMIN, body, expect.any(Object));
  });
});
