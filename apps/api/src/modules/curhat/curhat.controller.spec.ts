import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CurhatController } from './curhat.controller';
import { CurhatService } from './curhat.service';

describe('CurhatController (mahasiswa)', () => {
  let app: INestApplication;
  let curhat: Record<string, jest.Mock>;

  beforeEach(async () => {
    curhat = {
      kirim: jest.fn().mockResolvedValue({}),
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({}),
      hapus: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CurhatController],
      providers: [{ provide: CurhatService, useValue: curhat }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('lets only students write and read their own curhat, without caching', async () => {
    for (const role of ['PSIKOLOG', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).get('/api/v1/curhat').set('Authorization', bearer(role)).expect(403);
    }
    const res = await request(app.getHttpServer())
      .post('/api/v1/curhat').set('Authorization', bearer('MAHASISWA')).send({ isi: '  Lagi capek\nbanget  ' }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(curhat.kirim).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, 'Lagi capek\nbanget');
  });

  it.each([
    [{ isi: '' }],
    [{ isi: 'x'.repeat(5001) }],
    [{ isi: 'ok', id_mahasiswa: TEST_USERS.MAHASISWA.id }],
  ])('rejects invalid body %j', async (body) => {
    await request(app.getHttpServer()).post('/api/v1/curhat').set('Authorization', bearer('MAHASISWA')).send(body).expect(400);
    expect(curhat.kirim).not.toHaveBeenCalled();
  });
});
