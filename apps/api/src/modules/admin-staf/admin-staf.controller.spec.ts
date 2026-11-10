import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { AdminPsikologService } from './admin-psikolog.service';
import { AdminStafController, PsikologJadwalController } from './admin-staf.controller';
import { JadwalJagaService } from './jadwal-jaga.service';

describe('AdminStafController', () => {
  let app: INestApplication;
  let psikolog: Record<string, jest.Mock>;
  let jadwal: Record<string, jest.Mock>;
  const admin = TEST_USERS.DOSEN_ADMIN;
  const id = '22222222-2222-4222-8222-222222222222';
  const jadwalBody = { id_psikolog: id, tanggal: '2026-12-01', jam_mulai: '08:00', jam_selesai: '16:00' };

  beforeEach(async () => {
    psikolog = {
      daftar: jest.fn().mockResolvedValue([]),
      detail: jest.fn().mockResolvedValue({ id }),
      buat: jest.fn().mockResolvedValue({ psikolog: { id }, password_sementara: 'rahasia' }),
      ubah: jest.fn().mockResolvedValue({ id }),
      aktifkan: jest.fn().mockResolvedValue({ id }),
      nonaktifkan: jest.fn().mockResolvedValue({ psikolog: { id }, kasus_dikembalikan: 0 }),
      resetPassword: jest.fn().mockResolvedValue({ password_sementara: 'baru' }),
    };
    jadwal = {
      daftar: jest.fn().mockResolvedValue([]),
      milikSaya: jest.fn().mockResolvedValue([]),
      buat: jest.fn().mockResolvedValue({ id: 'j' }),
      ubah: jest.fn().mockResolvedValue({ id: 'j' }),
      hapus: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminStafController, PsikologJadwalController],
      providers: [
        { provide: AdminPsikologService, useValue: psikolog },
        { provide: JadwalJagaService, useValue: jadwal },
        ...authGuardProviders(),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('restricts account and schedule management to Dosen Admin', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/psikolog').expect(401);
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).get('/api/v1/admin/psikolog').set('Authorization', bearer(role)).expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/psikolog/${id}/aktifkan`).set('Authorization', bearer(role)).expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/admin/jadwal-jaga').set('Authorization', bearer(role)).send(jadwalBody).expect(403);
    }
    expect(psikolog.aktifkan).not.toHaveBeenCalled();
    expect(jadwal.buat).not.toHaveBeenCalled();
  });

  it('creates a psychologist account and never caches the temporary password', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/psikolog').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ nama: ' Dr. Sari ', email: ' Sari@Kampus.AC.ID ' }).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(psikolog.buat).toHaveBeenCalledWith(admin, { nama: 'Dr. Sari', email: 'sari@kampus.ac.id' }, expect.any(Object));

    for (const body of [{ nama: 'X', email: 'bukan-email' }, { nama: '', email: 'a@b.co' }, { nama: 'X', email: 'a@b.co', status_akun: 'AKTIF' }]) {
      await request(app.getHttpServer()).post('/api/v1/admin/psikolog').set('Authorization', bearer('DOSEN_ADMIN')).send(body).expect(400);
    }
  });

  it('runs lifecycle actions by id', async () => {
    for (const aksi of ['aktifkan', 'nonaktifkan', 'reset-password']) {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/psikolog/${id}/${aksi}`).set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    }
    expect(psikolog.aktifkan).toHaveBeenCalledWith(admin, id, expect.any(Object));
    expect(psikolog.nonaktifkan).toHaveBeenCalledWith(admin, id, expect.any(Object));
    expect(psikolog.resetPassword).toHaveBeenCalledWith(admin, id, expect.any(Object));
    await request(app.getHttpServer())
      .post('/api/v1/admin/psikolog/abc/aktifkan').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
  });

  it('filters the psychologist list', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/psikolog?status=AKTIF&q=sari').set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    expect(psikolog.daftar).toHaveBeenCalledWith({ status: 'AKTIF', q: 'sari' });
    await request(app.getHttpServer())
      .get('/api/v1/admin/psikolog?status=LIBUR').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
  });

  it('validates schedule payloads', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/jadwal-jaga').set('Authorization', bearer('DOSEN_ADMIN')).send(jadwalBody).expect(201);
    expect(jadwal.buat).toHaveBeenCalledWith(admin, jadwalBody, expect.any(Object));

    for (const override of [
      { tanggal: '01-12-2026' }, { jam_mulai: '8:00' }, { jam_mulai: '24:00' }, { jam_selesai: '25:00' },
      { id_psikolog: 'abc' }, { id_dosen: admin.id },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/admin/jadwal-jaga').set('Authorization', bearer('DOSEN_ADMIN'))
        .send({ ...jadwalBody, ...override }).expect(400);
    }
    expect(jadwal.buat).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer())
      .patch('/api/v1/admin/jadwal-jaga/99999999-9999-4999-8999-999999999999').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ jam_selesai: '24:00' }).expect(200);
    await request(app.getHttpServer())
      .delete('/api/v1/admin/jadwal-jaga/99999999-9999-4999-8999-999999999999').set('Authorization', bearer('DOSEN_ADMIN'))
      .expect(204);
  });

  it("lets a psychologist read only their own schedule", async () => {
    await request(app.getHttpServer())
      .get('/api/v1/psikolog/jadwal-jaga?dari=2026-12-01&id_psikolog=' + TEST_USERS.DOSEN_ADMIN.id)
      .set('Authorization', bearer('PSIKOLOG')).expect(200);
    expect(jadwal.milikSaya).toHaveBeenCalledWith(TEST_USERS.PSIKOLOG, { dari: '2026-12-01', sampai: undefined });
    await request(app.getHttpServer())
      .get('/api/v1/psikolog/jadwal-jaga').set('Authorization', bearer('MAHASISWA')).expect(403);
  });
});
