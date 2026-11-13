import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { BookingController, DirektoriPsikologController } from './booking.controller';
import { BookingService } from './booking.service';

describe('BookingController', () => {
  let app: INestApplication;
  let booking: Record<string, jest.Mock>;
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const body = {
    id_psikolog: idPsi,
    waktu_mulai: '2026-12-01T09:00:00+07:00',
    tipe_sesi: 'CHAT',
    keluhan_awal: '  Sulit tidur  ',
  };

  beforeEach(async () => {
    booking = {
      daftarPsikolog: jest.fn().mockResolvedValue([]),
      slot: jest.fn().mockResolvedValue([]),
      buat: jest.fn().mockResolvedValue({ id_sesi: 's' }),
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({ id_sesi: 's' }),
      ubahJadwal: jest.fn().mockResolvedValue({ id_sesi: 's' }),
      batal: jest.fn().mockResolvedValue({ id_sesi: 's' }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [BookingController, DirektoriPsikologController],
      providers: [{ provide: BookingService, useValue: booking }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('restricts booking endpoints to students', async () => {
    await request(app.getHttpServer()).post('/api/v1/booking').send(body).expect(401);
    for (const role of ['PSIKOLOG', 'DOSEN_ADMIN'] as const) {
      await request(app.getHttpServer()).post('/api/v1/booking').set('Authorization', bearer(role)).send(body).expect(403);
      await request(app.getHttpServer()).get('/api/v1/psikolog').set('Authorization', bearer(role)).expect(403);
    }
    expect(booking.buat).not.toHaveBeenCalled();
  });

  it('creates a booking with the student id from the token and a trimmed complaint', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/booking').set('Authorization', bearer('MAHASISWA')).send(body).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(booking.buat).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, { ...body, keluhan_awal: 'Sulit tidur' });
  });

  it.each([
    [{ waktu_mulai: '2026-12-01T09:00:00' }],
    [{ waktu_mulai: 'besok' }],
    [{ tipe_sesi: 'VIDEO' }],
    [{ keluhan_awal: '' }],
    [{ keluhan_awal: 'x'.repeat(2001) }],
    [{ id_psikolog: 'bukan-uuid' }],
    [{ id_mahasiswa: TEST_USERS.MAHASISWA.id }],
  ])('rejects invalid body %j', async (override) => {
    await request(app.getHttpServer())
      .post('/api/v1/booking').set('Authorization', bearer('MAHASISWA')).send({ ...body, ...override }).expect(400);
    expect(booking.buat).not.toHaveBeenCalled();
  });

  it('validates slot query and passes the student id', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/psikolog/${idPsi}/slot?tanggal=2026-12-01`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(booking.slot).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, idPsi, '2026-12-01');
    await request(app.getHttpServer())
      .get(`/api/v1/psikolog/${idPsi}/slot`).set('Authorization', bearer('MAHASISWA')).expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/psikolog/abc/slot?tanggal=2026-12-01').set('Authorization', bearer('MAHASISWA')).expect(400);
  });

  it('reschedules and cancels own bookings with validated bodies', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const server = app.getHttpServer();
    await request(server).patch(`/api/v1/booking/${id}/jadwal`).set('Authorization', bearer('MAHASISWA'))
      .send({ waktu_mulai: '2026-12-02T10:00:00+07:00' }).expect(200);
    expect(booking.ubahJadwal).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id, { waktu_mulai: '2026-12-02T10:00:00+07:00' });
    await request(server).patch(`/api/v1/booking/${id}/jadwal`).set('Authorization', bearer('MAHASISWA'))
      .send({ waktu_mulai: '2026-12-02T10:00:00+07:00', id_psikolog: id }).expect(400);

    await request(server).post(`/api/v1/booking/${id}/batal`).set('Authorization', bearer('MAHASISWA'))
      .send({ alasan: '  Sakit  ' }).expect(200);
    expect(booking.batal).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id, { alasan: 'Sakit' });
    await request(server).post(`/api/v1/booking/${id}/batal`).set('Authorization', bearer('PSIKOLOG')).send({}).expect(403);
    await request(server).post(`/api/v1/booking/${id}/batal`).set('Authorization', bearer('MAHASISWA'))
      .send({ alasan: 'x'.repeat(501) }).expect(400);
  });

  it('lists and shows own bookings', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/booking?cakupan=riwayat&limit=10').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(booking.daftar).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, { cakupan: 'riwayat', limit: 10 });
    const id = '44444444-4444-4444-8444-444444444444';
    const res = await request(app.getHttpServer())
      .get(`/api/v1/booking/${id}`).set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(booking.detail).toHaveBeenCalledWith(TEST_USERS.MAHASISWA.id, id);
  });
});
