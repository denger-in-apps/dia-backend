import { INestApplication, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { AuditService } from '../../common/audit/audit.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { AdminEskalasiController } from './admin-eskalasi.controller';
import { KONFIGURASI_DEFAULT, KonfigurasiSosService } from './konfigurasi-sos.service';
import { MAKS_PENERIMA_ESKALASI, PenerimaEskalasiService } from './penerima-eskalasi.service';

const admin = TEST_USERS.DOSEN_ADMIN;

function mockPool() {
  const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
  const pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
  return { pool, client };
}

describe('KonfigurasiSosService', () => {
  it('merges defaults when the singleton row is missing', async () => {
    const { pool } = mockPool();
    pool.query.mockResolvedValue({ rows: [] });
    const service = new KonfigurasiSosService(pool as unknown as Pool, { catat: jest.fn() } as never);
    await expect(service.ambil()).resolves.toEqual(KONFIGURASI_DEFAULT);
  });

  it('updates only provided whitelisted fields, records the admin and audits before/after', async () => {
    const { pool, client } = mockPool();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{ ...KONFIGURASI_DEFAULT }] };
      if (sql.includes('UPDATE konfigurasi_sos')) {
        return { rows: [{ ...KONFIGURASI_DEFAULT, durasi_eskalasi_detik: 120, sos_maks_per_jam: 3 }] };
      }
      return { rows: [] };
    });
    const audit = { catat: jest.fn() };
    const service = new KonfigurasiSosService(pool as unknown as Pool, audit as unknown as AuditService);

    const result = await service.ubah(admin, { durasi_eskalasi_detik: 120, sos_maks_per_jam: 3 }, { ip: '1.1.1.1' });

    expect(result.durasi_eskalasi_detik).toBe(120);
    const [sql, params] = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE konfigurasi_sos'))!;
    expect(sql).toContain('durasi_eskalasi_detik = $2, sos_maks_per_jam = $3, diubah_oleh = $1');
    expect(params).toEqual([admin.id, 120, 3]);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'KONFIGURASI_SOS_UBAH',
      metadata: {
        sebelum: { durasi_eskalasi_detik: 180, sos_maks_per_jam: 5 },
        sesudah: { durasi_eskalasi_detik: 120, sos_maks_per_jam: 3 },
      },
    }), client);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('ignores non-whitelisted keys and is a read when nothing changes', async () => {
    const { pool } = mockPool();
    pool.query.mockResolvedValue({ rows: [{ ...KONFIGURASI_DEFAULT }] });
    const service = new KonfigurasiSosService(pool as unknown as Pool, { catat: jest.fn() } as never);
    await service.ubah(admin, { id: 2, diubah_oleh: 'x' } as never, {});
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('PenerimaEskalasiService', () => {
  let encryption: EncryptionService;
  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
  });

  it('stores numbers encrypted per row and only returns them masked', async () => {
    const { pool, client } = mockPool();
    client.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('count(*)')) return { rows: [{ jumlah: 0 }] };
      if (sql.includes('INSERT INTO penerima_eskalasi')) {
        return { rows: [{ id: params[0], nama: params[1], no_telepon_enc: params[2], aktif: params[3], created_at: new Date() }] };
      }
      return { rows: [] };
    });
    const audit = { catat: jest.fn() };
    const service = new PenerimaEskalasiService(pool as unknown as Pool, encryption, audit as unknown as AuditService);

    const created = await service.buat(admin, { nama: 'Satgas', no_telepon: '081234567890' }, {});

    expect(created.no_telepon_masked).toBe('0812*****890');
    expect(JSON.stringify(created)).not.toContain('081234567890');
    const insert = client.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO penerima_eskalasi'))!;
    expect(encryption.decrypt(insert[1][2], `penerima_eskalasi:no_telepon_enc:${insert[1][0]}`).toString()).toBe('081234567890');
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'PENERIMA_ESKALASI_BUAT' }), client);
  });

  it(`limits the list to ${MAKS_PENERIMA_ESKALASI} recipients`, async () => {
    const { pool, client } = mockPool();
    client.query.mockImplementation(async (sql: string) =>
      sql.includes('count(*)') ? { rows: [{ jumlah: MAKS_PENERIMA_ESKALASI }] } : { rows: [] });
    const service = new PenerimaEskalasiService(pool as unknown as Pool, encryption, { catat: jest.fn() } as never);
    await expect(service.buat(admin, { nama: 'x', no_telepon: '081234567890' }, {}))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns 404 when updating or deleting an unknown recipient', async () => {
    const { pool } = mockPool();
    const service = new PenerimaEskalasiService(pool as unknown as Pool, encryption, { catat: jest.fn() } as never);
    await expect(service.ubah(admin, 'id', { aktif: false }, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.hapus(admin, 'id', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminEskalasiController', () => {
  let app: INestApplication;
  let konfigurasi: { ambil: jest.Mock; ubah: jest.Mock };
  let penerima: Record<string, jest.Mock>;
  const id = '88888888-8888-4888-8888-888888888888';

  beforeEach(async () => {
    konfigurasi = { ambil: jest.fn().mockResolvedValue(KONFIGURASI_DEFAULT), ubah: jest.fn().mockResolvedValue(KONFIGURASI_DEFAULT) };
    penerima = {
      daftar: jest.fn().mockResolvedValue([]),
      buat: jest.fn().mockResolvedValue({ id }),
      ubah: jest.fn().mockResolvedValue({ id }),
      hapus: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminEskalasiController],
      providers: [
        { provide: KonfigurasiSosService, useValue: konfigurasi },
        { provide: PenerimaEskalasiService, useValue: penerima },
        ...authGuardProviders(),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is restricted to Dosen Admin', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/konfigurasi-sos').expect(401);
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).get('/api/v1/admin/konfigurasi-sos').set('Authorization', bearer(role)).expect(403);
      await request(app.getHttpServer())
        .put('/api/v1/admin/konfigurasi-sos').set('Authorization', bearer(role)).send({ durasi_eskalasi_detik: 60 }).expect(403);
      await request(app.getHttpServer()).get('/api/v1/admin/penerima-eskalasi').set('Authorization', bearer(role)).expect(403);
    }
    expect(konfigurasi.ubah).not.toHaveBeenCalled();
  });

  it('updates the SOS configuration with validated values', async () => {
    const body = { durasi_eskalasi_detik: 120, kontak_darurat_untuk_perlu_verifikasi: true, sos_maks_per_jam: 3 };
    await request(app.getHttpServer())
      .put('/api/v1/admin/konfigurasi-sos').set('Authorization', bearer('DOSEN_ADMIN')).send(body).expect(200);
    expect(konfigurasi.ubah).toHaveBeenCalledWith(admin, body, expect.any(Object));
  });

  it.each([
    [{ durasi_eskalasi_detik: 10 }],
    [{ durasi_eskalasi_detik: 5000 }],
    [{ durasi_eskalasi_detik: '120' }],
    [{ sos_maks_per_jam: 0 }],
    [{ maks_eskalasi_kontak_per_hari: 11 }],
    [{ hotline_label: '' }],
    [{ hotline_aktif: 'ya' }],
    [{ id: 2 }],
    [{ diubah_oleh: admin.id }],
  ])('rejects invalid configuration %j', async (body) => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/konfigurasi-sos').set('Authorization', bearer('DOSEN_ADMIN')).send(body).expect(400);
    expect(konfigurasi.ubah).not.toHaveBeenCalled();
  });

  it('manages escalation recipients with validated phone numbers', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/penerima-eskalasi').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ nama: ' Satgas Kampus ', no_telepon: '0812-3456-7890' }).expect(201);
    expect(penerima.buat).toHaveBeenCalledWith(admin, { nama: 'Satgas Kampus', no_telepon: '081234567890' }, expect.any(Object));

    await request(app.getHttpServer())
      .post('/api/v1/admin/penerima-eskalasi').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ nama: 'X', no_telepon: '12' }).expect(400);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/penerima-eskalasi/${id}`).set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ aktif: false }).expect(200);
    expect(penerima.ubah).toHaveBeenCalledWith(admin, id, { aktif: false }, expect.any(Object));

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/penerima-eskalasi/${id}`).set('Authorization', bearer('DOSEN_ADMIN')).expect(204);
    await request(app.getHttpServer())
      .delete('/api/v1/admin/penerima-eskalasi/abc').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
  });
});
