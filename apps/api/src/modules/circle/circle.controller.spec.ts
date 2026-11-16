import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CircleController, KategoriMinatController, PreferensiMinatController } from './circle.controller';
import { CircleService } from './circle.service';
import { RekomendasiService } from './rekomendasi.service';

describe('CircleController (mahasiswa)', () => {
  let app: INestApplication;
  let circle: Record<string, jest.Mock>;
  let rekomendasi: Record<string, jest.Mock>;
  const id = '99999999-9999-4999-8999-999999999999';
  const kategori = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    circle = {
      kategori: jest.fn().mockResolvedValue([]),
      telusuri: jest.fn().mockResolvedValue([]),
      saya: jest.fn().mockResolvedValue({}),
      detail: jest.fn().mockResolvedValue({}),
      ajukan: jest.fn().mockResolvedValue({}),
      gabung: jest.fn().mockResolvedValue({ baru: true }),
      keluar: jest.fn().mockResolvedValue(undefined),
      ubahAnonim: jest.fn().mockResolvedValue({}),
      daftarPesan: jest.fn().mockResolvedValue([]),
      kirimPesan: jest.fn().mockResolvedValue({}),
    };
    rekomendasi = {
      rekomendasi: jest.fn().mockResolvedValue({ rekomendasi: [] }),
      preferensi: jest.fn().mockResolvedValue([]),
      simpanPreferensi: jest.fn().mockResolvedValue([]),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [KategoriMinatController, CircleController, PreferensiMinatController],
      providers: [
        { provide: CircleService, useValue: circle },
        { provide: RekomendasiService, useValue: rekomendasi },
        ...authGuardProviders(),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('lists categories for every role, but circles only for students', async () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).get('/api/v1/kategori-minat').set('Authorization', bearer(role)).expect(200);
    }
    await request(app.getHttpServer()).get('/api/v1/circles').set('Authorization', bearer('PSIKOLOG')).expect(403);
  });

  it('routes /circles/saya before /circles/:id', async () => {
    await request(app.getHttpServer()).get('/api/v1/circles/saya').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(circle.saya).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id);
    expect(circle.detail).not.toHaveBeenCalled();
  });

  it('returns 201 for a new membership and 200 when already a member', async () => {
    await request(app.getHttpServer()).post(`/api/v1/circles/${id}/gabung`).set('Authorization', bearer('MAHASISWA')).expect(201);
    circle.gabung.mockResolvedValue({ baru: false });
    await request(app.getHttpServer()).post(`/api/v1/circles/${id}/gabung`).set('Authorization', bearer('MAHASISWA')).expect(200);
  });

  it('validates proposals (quota 5–8) and filters', async () => {
    await request(app.getHttpServer()).post('/api/v1/circles').set('Authorization', bearer('MAHASISWA'))
      .send({ nama_circle: 'Pejuang Skripsi', id_kategori: kategori, kuota: 4 }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/circles').set('Authorization', bearer('MAHASISWA'))
      .send({ nama_circle: 'Pejuang Skripsi', id_kategori: kategori, kuota: 6 }).expect(201);
    await request(app.getHttpServer()).get(`/api/v1/circles?kategori=${kategori}&q=skripsi`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(circle.telusuri).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, { kategori, q: 'skripsi' });
  });

  it('posts validated chat messages', async () => {
    await request(app.getHttpServer()).post(`/api/v1/circles/${id}/pesan`).set('Authorization', bearer('MAHASISWA')).send({ isi: '' }).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/circles/${id}/pesan`).set('Authorization', bearer('MAHASISWA')).send({ isi: ' halo ' }).expect(201);
    expect(circle.kirimPesan).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id, 'halo');
  });

  it('routes /circles/rekomendasi before /circles/:id and stores preferences (SCRUM-266)', async () => {
    await request(app.getHttpServer()).get('/api/v1/circles/rekomendasi?limit=3').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(rekomendasi.rekomendasi).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, 3);
    expect(circle.detail).not.toHaveBeenCalled();

    await request(app.getHttpServer()).put('/api/v1/me/preferensi-minat').set('Authorization', bearer('MAHASISWA'))
      .send({ id_kategori: ['bukan-uuid'] }).expect(400);
    await request(app.getHttpServer()).put('/api/v1/me/preferensi-minat').set('Authorization', bearer('MAHASISWA'))
      .send({ id_kategori: [kategori] }).expect(200);
    expect(rekomendasi.simpanPreferensi).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, [kategori]);
    await request(app.getHttpServer()).get('/api/v1/me/preferensi-minat').set('Authorization', bearer('PSIKOLOG')).expect(403);
  });
});
