import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { GentaController } from './genta.controller';
import { GentaService } from './genta.service';

describe('GentaController', () => {
  let app: INestApplication;
  let genta: Record<string, jest.Mock>;
  const mhs = TEST_USERS.MAHASISWA;
  const jwtLike = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  const valid = { token_konfirmasi: jwtLike, situasi: 'SERANGAN_PANIK', konfirmasi: true };

  beforeEach(async () => {
    genta = {
      mintaKonfirmasi: jest.fn().mockResolvedValue({ token_konfirmasi: 't' }),
      buatSos: jest.fn().mockResolvedValue({ baru: true, sos: {}, hotline: {} }),
      statusAktif: jest.fn().mockResolvedValue({ sos: null, hotline: {} }),
      batalkan: jest.fn().mockResolvedValue({}),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [GentaController],
      providers: [{ provide: GentaService, useValue: genta }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('requires an authenticated student', async () => {
    await request(app.getHttpServer()).post('/api/v1/genta/sos').send(valid).expect(401);
    for (const role of ['PSIKOLOG', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer())
        .post('/api/v1/genta/sos').set('Authorization', bearer(role)).send(valid).expect(403);
    }
    expect(genta.buatSos).not.toHaveBeenCalled();
  });

  it('issues a confirmation step for the student', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos/konfirmasi').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(genta.mintaKonfirmasi).toHaveBeenCalledWith(mhs.id);
  });

  it('returns 201 for a new SOS and 200 for an existing active one', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos').set('Authorization', bearer('MAHASISWA')).send(valid).expect(201);
    expect(genta.buatSos).toHaveBeenCalledWith(mhs.id, valid);

    genta.buatSos.mockResolvedValue({ baru: false, sos: {}, hotline: {} });
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos').set('Authorization', bearer('MAHASISWA')).send(valid).expect(200);
  });

  it.each([
    [{ ...valid, konfirmasi: false }],
    [{ ...valid, konfirmasi: 'true' }],
    [{ ...valid, situasi: 'BOSAN' }],
    [{ situasi: 'SERANGAN_PANIK', konfirmasi: true }],
    [{ ...valid, token_konfirmasi: 'bukan-jwt' }],
    [{ ...valid, prioritas: 'KRITIS' }],
    [{ ...valid, id_mahasiswa: TEST_USERS.PSIKOLOG.id }],
  ])('rejects invalid SOS body %j', async (body) => {
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos').set('Authorization', bearer('MAHASISWA')).send(body).expect(400);
    expect(genta.buatSos).not.toHaveBeenCalled();
  });

  it('reads the active SOS and cancels by id for the owner', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/genta/sos/aktif').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(genta.statusAktif).toHaveBeenCalledWith(mhs.id);

    const id = '55555555-5555-4555-8555-555555555555';
    await request(app.getHttpServer())
      .post(`/api/v1/genta/sos/${id}/batal`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(genta.batalkan).toHaveBeenCalledWith(mhs.id, id);

    await request(app.getHttpServer())
      .post('/api/v1/genta/sos/abc/batal').set('Authorization', bearer('MAHASISWA')).expect(400);
  });
});
