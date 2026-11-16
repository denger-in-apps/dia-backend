import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CurhatPsikologController } from './curhat-psikolog.controller';
import { CurhatPsikologService } from './curhat-psikolog.service';

describe('CurhatPsikologController', () => {
  let app: INestApplication;
  let curhat: Record<string, jest.Mock>;
  const id = '88888888-8888-4888-8888-888888888888';

  beforeEach(async () => {
    curhat = {
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({}),
      balas: jest.fn().mockResolvedValue({}),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CurhatPsikologController],
      providers: [{ provide: CurhatPsikologService, useValue: curhat }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is only for psychologists (admins have no access to curhat content)', async () => {
    for (const role of ['MAHASISWA', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).get('/api/v1/psikolog/curhat').set('Authorization', bearer(role)).expect(403);
    }
  });

  it('filters by status and replies with a validated body', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/psikolog/curhat?status=BARU&limit=10').set('Authorization', bearer('PSIKOLOG')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(curhat.daftar).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, { status: 'BARU', limit: 10 }, expect.any(Object));
    await request(app.getHttpServer()).get('/api/v1/psikolog/curhat?status=HAPUS').set('Authorization', bearer('PSIKOLOG')).expect(400);

    await request(app.getHttpServer())
      .post(`/api/v1/psikolog/curhat/${id}/balasan`).set('Authorization', bearer('PSIKOLOG')).send({ isi: ' Saran ' }).expect(201);
    expect(curhat.balas).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, id, 'Saran', expect.any(Object));
    await request(app.getHttpServer())
      .post(`/api/v1/psikolog/curhat/${id}/balasan`).set('Authorization', bearer('PSIKOLOG')).send({ isi: '' }).expect(400);
  });
});
