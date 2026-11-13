import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { GentaController } from './genta.controller';
import { GentaService } from './genta.service';
import { GentaPsikologController } from './genta-psikolog.controller';
import { GentaPsikologService } from './genta-psikolog.service';
import { AuditService } from '../../common/audit/audit.service';

describe('GentaController', () => {
  let app: INestApplication;
  let genta: Record<string, jest.Mock>;
  let gentaPsikolog: Record<string, jest.Mock>;
  let audit: { catat: jest.Mock };
  const idSos = '55555555-5555-4555-8555-555555555555';
  const mhs = TEST_USERS.MAHASISWA;
  const jwtLike = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  const valid = { token_konfirmasi: jwtLike, situasi: 'SERANGAN_PANIK', konfirmasi: true };

  beforeEach(async () => {
    genta = {
      mintaKonfirmasi: jest.fn().mockResolvedValue({ token_konfirmasi: 't' }),
      buatSos: jest.fn().mockResolvedValue({ baru: true, sos: {}, hotline: {} }),
      statusAktif: jest.fn().mockResolvedValue({ sos: null, hotline: {} }),
      batalkan: jest.fn().mockResolvedValue({}),
      bagikanLokasi: jest.fn().mockResolvedValue({ lokasi_izin: true }),
      cabutLokasi: jest.fn().mockResolvedValue({ lokasi_izin: false }),
    };
    gentaPsikolog = {
      lokasiSos: jest.fn().mockResolvedValue({ lat: 1, lng: 2 }),
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({ id_sos: idSos }),
      ambil: jest.fn().mockResolvedValue({ id_sos: idSos, status_penanganan: 'DIAMBIL' }),
      ubahStatus: jest.fn().mockResolvedValue({ id_sos: idSos, status_penanganan: 'SELESAI' }),
    };
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [GentaController, GentaPsikologController],
      providers: [
        { provide: AuditService, useValue: audit },
        { provide: GentaService, useValue: genta },
        { provide: GentaPsikologService, useValue: gentaPsikolog },
        ...authGuardProviders(),
      ],
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

    it('accepts an optional location with the SOS', async () => {
    const body = { ...valid, lokasi: { lat: -6.2, lng: 106.8, akurasi_m: 12.5 } };
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos').set('Authorization', bearer('MAHASISWA')).send(body).expect(201);
    expect(genta.buatSos).toHaveBeenCalledWith(mhs.id, expect.objectContaining({ lokasi: body.lokasi }));
  });

  it('rejects null location when creating an SOS', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos')
      .set('Authorization', bearer('MAHASISWA'))
      .send({ ...valid, lokasi: null })
      .expect(400);

    expect(genta.buatSos).not.toHaveBeenCalled();
  });

  it.each([
    [{ lat: 91, lng: 0 }],
    [{ lat: 0, lng: -181 }],
    [{ lat: '1', lng: 2 }],
    [{ lat: 1 }],
    [{ lat: 1, lng: 2, akurasi_m: -1 }],
    [{ lat: 1, lng: 2, alamat: 'rumah' }],
  ])('rejects invalid coordinates %j', async (lokasi) => {
    await request(app.getHttpServer())
      .post('/api/v1/genta/sos').set('Authorization', bearer('MAHASISWA')).send({ ...valid, lokasi }).expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/genta/sos/${idSos}/lokasi`).set('Authorization', bearer('MAHASISWA')).send(lokasi).expect(400);
    expect(genta.buatSos).not.toHaveBeenCalled();
    expect(genta.bagikanLokasi).not.toHaveBeenCalled();
  });

  it('lets the student share and withdraw a location later', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/genta/sos/${idSos}/lokasi`).set('Authorization', bearer('MAHASISWA'))
      .send({ lat: 1, lng: 2 }).expect(200);
    expect(genta.bagikanLokasi).toHaveBeenCalledWith(mhs.id, idSos, { lat: 1, lng: 2 });

    await request(app.getHttpServer())
      .delete(`/api/v1/genta/sos/${idSos}/lokasi`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(genta.cabutLokasi).toHaveBeenCalledWith(mhs.id, idSos);
  });

  it('exposes SOS locations only to psychologists, without caching', async () => {
    await request(app.getHttpServer()).get(`/api/v1/psikolog/sos/${idSos}/lokasi`).expect(401);
    for (const role of ['MAHASISWA', 'DOSEN_ADMIN'] as const) {
      const denied = await request(app.getHttpServer())
        .get(`/api/v1/psikolog/sos/${idSos}/lokasi`).set('Authorization', bearer(role)).expect(403);
      // Respons 403 tetap sama dengan penolakan RBAC global.
      expect(denied.body).toEqual({ message: 'Peran tidak memiliki akses ke resource ini', error: 'Forbidden', statusCode: 403 });
    }
    // PBI-06: penolakan role pada endpoint lokasi diaudit, tepat sekali per percobaan.
    expect(audit.catat).toHaveBeenCalledTimes(2);
    for (const [i, role] of (['MAHASISWA', 'DOSEN_ADMIN'] as const).entries()) {
      expect(audit.catat.mock.calls[i][0]).toMatchObject({
        aktor: TEST_USERS[role], aksi: 'SOS_LOKASI_READ', resourceType: 'log_sos', resourceId: idSos,
        hasil: 'DITOLAK', metadata: { alasan: 'ROLE_TIDAK_DIIZINKAN' },
      });
    }
    expect(gentaPsikolog.lokasiSos).not.toHaveBeenCalled();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/psikolog/sos/${idSos}/lokasi`).set('Authorization', bearer('PSIKOLOG')).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(gentaPsikolog.lokasiSos).toHaveBeenCalledTimes(1);
    expect(gentaPsikolog.lokasiSos).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, idSos, expect.any(Object));
    // Akses psikolog diaudit oleh service (di-mock di sini), bukan oleh filter.
    expect(audit.catat).toHaveBeenCalledTimes(2);
  });

  it('does not audit role denials on other psikolog endpoints (filter scoped to /lokasi only)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/psikolog/sos/${idSos}`).set('Authorization', bearer('MAHASISWA')).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/psikolog/sos').set('Authorization', bearer('DOSEN_ADMIN')).expect(403);
    expect(audit.catat).not.toHaveBeenCalled();
  });

  describe('dashboard psikolog', () => {
    it('is restricted to psychologists', async () => {
      for (const role of ['MAHASISWA', 'DOSEN_ADMIN'] as const) {
        await request(app.getHttpServer()).get('/api/v1/psikolog/sos').set('Authorization', bearer(role)).expect(403);
        await request(app.getHttpServer())
          .post(`/api/v1/psikolog/sos/${idSos}/ambil`).set('Authorization', bearer(role)).expect(403);
        await request(app.getHttpServer())
          .patch(`/api/v1/psikolog/sos/${idSos}/status`).set('Authorization', bearer(role))
          .send({ status: 'SELESAI' }).expect(403);
      }
      await request(app.getHttpServer()).get('/api/v1/psikolog/sos').expect(401);
      expect(gentaPsikolog.daftar).not.toHaveBeenCalled();
      expect(gentaPsikolog.ambil).not.toHaveBeenCalled();
      expect(gentaPsikolog.ubahStatus).not.toHaveBeenCalled();
    });

    it('lists the queue with validated filters', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/psikolog/sos?cakupan=milik_saya&limit=20').set('Authorization', bearer('PSIKOLOG')).expect(200);
      // Daftar dapat memuat nama mahasiswa (kasus milik sendiri) → tidak boleh di-cache.
      expect(list.headers['cache-control']).toBe('no-store');
      expect(gentaPsikolog.daftar).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, { cakupan: 'milik_saya', limit: 20 });
      for (const cakupan of ['aktif', 'antrean', 'riwayat']) {
        await request(app.getHttpServer())
          .get(`/api/v1/psikolog/sos?cakupan=${cakupan}&limit=100`).set('Authorization', bearer('PSIKOLOG')).expect(200);
      }

      for (const qs of ['cakupan=semua', 'limit=0', 'limit=1000', 'id_psikolog=x']) {
        await request(app.getHttpServer())
          .get(`/api/v1/psikolog/sos?${qs}`).set('Authorization', bearer('PSIKOLOG')).expect(400);
      }
    });

    it('serves case details without caching', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/psikolog/sos/${idSos}`).set('Authorization', bearer('PSIKOLOG')).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(gentaPsikolog.detail).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, idSos, expect.any(Object));
    });

    it('takes a case', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/psikolog/sos/${idSos}/ambil`).set('Authorization', bearer('PSIKOLOG')).expect(200);
      expect(gentaPsikolog.ambil).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, idSos, expect.any(Object));
    });

    it('validates status updates', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/psikolog/sos/${idSos}/status`).set('Authorization', bearer('PSIKOLOG'))
        .send({ status: 'SELESAI', laporan_tidak_valid: true, catatan: '  Mengaku iseng  ' }).expect(200);
      expect(gentaPsikolog.ubahStatus).toHaveBeenCalledWith(
        TEST_USERS.PSIKOLOG, idSos, { status: 'SELESAI', laporan_tidak_valid: true, catatan: 'Mengaku iseng' },
        expect.any(Object),
      );

      for (const body of [
        { status: 'BARU' },
        { status: 'DIAMBIL' },
        { status: 'SELESAI', laporan_tidak_valid: true },
        { status: 'SELESAI', laporan_tidak_valid: true, catatan: '   ' },
        { status: 'SELESAI', catatan: 'x'.repeat(2001) },
        { status: 'SELESAI', id_psikolog: TEST_USERS.PSIKOLOG.id },
      ]) {
        await request(app.getHttpServer())
          .patch(`/api/v1/psikolog/sos/${idSos}/status`).set('Authorization', bearer('PSIKOLOG')).send(body).expect(400);
      }
      expect(gentaPsikolog.ubahStatus).toHaveBeenCalledTimes(1);
    });
  });
});
