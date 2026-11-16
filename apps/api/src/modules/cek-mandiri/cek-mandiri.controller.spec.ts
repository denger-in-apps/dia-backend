import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CekMandiriController } from './cek-mandiri.controller';
import { CekMandiriService } from './cek-mandiri.service';

describe('CekMandiriController', () => {
  let app: INestApplication;
  let cek: Record<string, jest.Mock>;
  const id = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    cek = {
      template: jest.fn().mockResolvedValue([]),
      kirim: jest.fn().mockResolvedValue({}),
      riwayat: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({}),
      hapus: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CekMandiriController],
      providers: [{ provide: CekMandiriService, useValue: cek }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is only for students (psychologists and admins see aggregates elsewhere)', async () => {
    for (const role of ['PSIKOLOG', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).get('/api/v1/cek-mandiri/riwayat').set('Authorization', bearer(role)).expect(403);
    }
    await request(app.getHttpServer()).get('/api/v1/cek-mandiri/template').expect(401);
  });

  it('submits answers without trusting client scores', async () => {
    const body = { id_template_phq9: id, jawaban_phq9: [0, 1, 2, 3, 0, 1, 2, 3, 0] };
    const res = await request(app.getHttpServer())
      .post('/api/v1/cek-mandiri').set('Authorization', bearer('MAHASISWA')).send(body).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(cek.kirim).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, body);
    await request(app.getHttpServer()).post('/api/v1/cek-mandiri').set('Authorization', bearer('MAHASISWA'))
      .send({ ...body, skor_phq9: 0 }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/cek-mandiri').set('Authorization', bearer('MAHASISWA'))
      .send({ ...body, jawaban_phq9: [4, 0, 0, 0, 0, 0, 0, 0, 0] }).expect(400);
  });

  it('reads and deletes own results', async () => {
    await request(app.getHttpServer()).get(`/api/v1/cek-mandiri/${id}`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(cek.detail).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id);
    await request(app.getHttpServer()).delete(`/api/v1/cek-mandiri/${id}`).set('Authorization', bearer('MAHASISWA')).expect(204);
    expect(cek.hapus).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id);
  });
});
