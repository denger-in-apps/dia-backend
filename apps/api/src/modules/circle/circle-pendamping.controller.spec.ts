import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CirclePendampingController } from './circle-pendamping.controller';
import { CirclePendampingService } from './circle-pendamping.service';

describe('CirclePendampingController', () => {
  let app: INestApplication;
  let pendamping: Record<string, jest.Mock>;
  const id = '99999999-9999-4999-8999-999999999999';
  const pid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(async () => {
    pendamping = Object.fromEntries(
      ['daftar', 'detail', 'daftarPesan', 'kirimPesan', 'sembunyikan', 'pulihkan'].map((n) => [n, jest.fn().mockResolvedValue({})]),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [CirclePendampingController],
      providers: [{ provide: CirclePendampingService, useValue: pendamping }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is only for psychologists', async () => {
    for (const role of ['MAHASISWA', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).get('/api/v1/psikolog/circles').set('Authorization', bearer(role)).expect(403);
      await request(app.getHttpServer()).post(`/api/v1/psikolog/circles/${id}/pesan/${pid}/moderasi`).set('Authorization', bearer(role))
        .send({ alasan: 'Melanggar aturan' }).expect(403);
    }
  });

  it('moderates with a required reason and can restore', async () => {
    await request(app.getHttpServer()).post(`/api/v1/psikolog/circles/${id}/pesan/${pid}/moderasi`).set('Authorization', bearer('PSIKOLOG'))
      .send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/psikolog/circles/${id}/pesan/${pid}/moderasi`).set('Authorization', bearer('PSIKOLOG'))
      .send({ alasan: ' Melanggar aturan ' }).expect(200);
    expect(pendamping.sembunyikan).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, id, pid, 'Melanggar aturan', expect.any(Object));
    await request(app.getHttpServer()).post(`/api/v1/psikolog/circles/${id}/pesan/${pid}/pulihkan`).set('Authorization', bearer('PSIKOLOG')).expect(200);
    expect(pendamping.pulihkan).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, id, pid, expect.any(Object));
  });
});
