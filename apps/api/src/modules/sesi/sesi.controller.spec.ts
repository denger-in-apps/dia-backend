import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { KunciE2eeController, RuangSesiController, SesiPsikologController } from './sesi.controller';
import { RuangSesiService } from './ruang-sesi.service';
import { SesiGateway } from './sesi.gateway';
import { SesiPsikologService } from './sesi-psikolog.service';

describe('Sesi controllers', () => {
  let app: INestApplication;
  let ruang: Record<string, jest.Mock>;
  let sesi: Record<string, jest.Mock>;
  let gateway: Record<string, jest.Mock>;
  const id = '44444444-4444-4444-8444-444444444444';
  const pesanBody = { ciphertext: 'Y2lwaGVydGV4dC1ieXRlcw==', nonce: 'AAAAAAAAAAAAAAAA' };

  beforeEach(async () => {
    ruang = {
      kunciSaya: jest.fn().mockResolvedValue({}),
      simpanKunci: jest.fn().mockResolvedValue({}),
      kunciLawan: jest.fn().mockResolvedValue({}),
      daftarPesan: jest.fn().mockResolvedValue([]),
      kirimPesan: jest.fn().mockResolvedValue({ id_pesan: 'p1' }),
    };
    sesi = {
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({}),
      ubahStatus: jest.fn().mockResolvedValue({ id_sesi: id, status_sesi: 'SELESAI' }),
    };
    gateway = { siarkanPesan: jest.fn(), siarkanStatus: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [KunciE2eeController, RuangSesiController, SesiPsikologController],
      providers: [
        { provide: RuangSesiService, useValue: ruang },
        { provide: SesiPsikologService, useValue: sesi },
        { provide: SesiGateway, useValue: gateway },
        ...authGuardProviders(),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('allows only students and psychologists in session rooms and key endpoints', async () => {
    const server = app.getHttpServer();
    await request(server).get(`/api/v1/sesi/${id}/pesan`).set('Authorization', bearer('DOSEN_ADMIN')).expect(403);
    await request(server).put('/api/v1/me/kunci-e2ee').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ kunci_publik: 'AAAA' }).expect(403);
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(server).get(`/api/v1/sesi/${id}/kunci`).set('Authorization', bearer(role)).expect(200);
      expect(ruang.kunciLawan).toHaveBeenLastCalledWith(TEST_USERS[role], id);
    }
  });

  it('stores a message over HTTP and broadcasts it to the room', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/sesi/${id}/pesan`).set('Authorization', bearer('MAHASISWA')).send(pesanBody).expect(201);
    expect(ruang.kirimPesan).toHaveBeenCalledWith(TEST_USERS.MAHASISWA, id, pesanBody.ciphertext, pesanBody.nonce);
    expect(gateway.siarkanPesan).toHaveBeenCalledWith(id, { id_pesan: 'p1' });
  });

  it.each([
    [{ ciphertext: 'bukan base64!!', nonce: 'AAAA' }],
    [{ ciphertext: 'AAAA' }],
    [{ ...{ ciphertext: 'AAAA', nonce: 'AAAA' }, plaintext: 'halo' }],
  ])('rejects malformed message body %j', async (body) => {
    await request(app.getHttpServer())
      .post(`/api/v1/sesi/${id}/pesan`).set('Authorization', bearer('MAHASISWA')).send(body).expect(400);
    expect(ruang.kirimPesan).not.toHaveBeenCalled();
  });

  it('restricts the session schedule to psychologists and broadcasts status changes', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/psikolog/sesi').set('Authorization', bearer('MAHASISWA')).expect(403);
    await request(server).patch(`/api/v1/psikolog/sesi/${id}/status`).set('Authorization', bearer('PSIKOLOG'))
      .send({ status: 'DIBATALKAN' }).expect(400);
    await request(server).patch(`/api/v1/psikolog/sesi/${id}/status`).set('Authorization', bearer('PSIKOLOG'))
      .send({ status: 'SELESAI' }).expect(200);
    expect(sesi.ubahStatus).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, id, { status: 'SELESAI' }, expect.any(Object));
    expect(gateway.siarkanStatus).toHaveBeenCalledWith(id, { id_sesi: id, status_sesi: 'SELESAI' });
    const res = await request(server).get(`/api/v1/psikolog/sesi/${id}`).set('Authorization', bearer('PSIKOLOG')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
