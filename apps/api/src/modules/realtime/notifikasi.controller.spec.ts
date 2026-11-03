import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { DATABASE_POOL } from '../../database/database.module';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { NotifikasiController } from './notifikasi.controller';

describe('NotifikasiController', () => {
  let app: INestApplication;
  let pool: { query: jest.Mock };
  const psi = TEST_USERS.PSIKOLOG;
  const id = '77777777-7777-4777-8777-777777777777';

  beforeEach(async () => {
    // Pool yang sama melayani guard (cek akun aktif) dan controller.
    pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM notifikasi')) return { rows: [{ id, jenis: 'SOS_BARU' }] };
        if (sql.includes('UPDATE notifikasi')) return { rowCount: 1, rows: [] };
        return { rows: [{ nim: null, status_aktif: true, terakhir_verifikasi_at: new Date() }] };
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [NotifikasiController],
      providers: authGuardProviders(),
    })
      .overrideProvider(DATABASE_POOL).useValue(pool)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/notifikasi').expect(401);
  });

  it('lists only the caller own notifications with filters', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/notifikasi?belum_dibaca=true&limit=10').set('Authorization', bearer('PSIKOLOG')).expect(200);
    const call = pool.query.mock.calls.find(([sql]) => String(sql).includes('FROM notifikasi'))!;
    expect(call[1]).toEqual([psi.id, 'PSIKOLOG', true, 10]);
  });

  it('validates query parameters', async () => {
    for (const qs of ['limit=0', 'limit=500', 'limit=abc', 'belum_dibaca=ya', 'id_penerima=x']) {
      await request(app.getHttpServer())
        .get(`/api/v1/notifikasi?${qs}`).set('Authorization', bearer('PSIKOLOG')).expect(400);
    }
  });

  it('marks a notification as read only for its owner', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/notifikasi/${id}/dibaca`).set('Authorization', bearer('PSIKOLOG')).expect(204);
    const call = pool.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE notifikasi'))!;
    expect(call[1]).toEqual([id, psi.id, 'PSIKOLOG']);

    pool.query.mockImplementation(async (sql: string) => (
      sql.includes('UPDATE notifikasi')
        ? { rowCount: 0, rows: [] }
        : { rows: [{ nim: null, status_aktif: true, terakhir_verifikasi_at: new Date() }] }
    ));
    await request(app.getHttpServer())
      .post(`/api/v1/notifikasi/${id}/dibaca`).set('Authorization', bearer('PSIKOLOG')).expect(404);
  });
});
