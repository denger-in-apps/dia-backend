import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { AkunController } from './akun.controller';
import { AkunService } from './akun.service';

describe('AkunController', () => {
  let app: INestApplication;
  let akun: Record<string, jest.Mock>;
  const mhs = TEST_USERS.MAHASISWA;
  const kontakId = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    akun = {
      profil: jest.fn().mockResolvedValue({ id: mhs.id, nama: 'Mhs' }),
      ubahProfil: jest.fn().mockResolvedValue({ id: mhs.id, nama_tampilan: 'Budi' }),
      ekspor: jest.fn().mockResolvedValue({ profil: { id: mhs.id } }),
      hapusAkun: jest.fn().mockResolvedValue(undefined),
      daftarKontak: jest.fn().mockResolvedValue([]),
      tambahKontak: jest.fn().mockResolvedValue({ id: kontakId }),
      ubahKontak: jest.fn().mockResolvedValue({ id: kontakId }),
      hapusKontak: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AkunController],
      providers: [{ provide: AkunService, useValue: akun }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    expect(akun.profil).not.toHaveBeenCalled();
  });

  it.each(['PSIKOLOG', 'DOSEN_ADMIN'] as const)('forbids role %s', async (role) => {
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', bearer(role)).expect(403);
    await request(app.getHttpServer())
      .delete('/api/v1/me').set('Authorization', bearer(role)).send({ konfirmasi: 'HAPUS' }).expect(403);
    expect(akun.profil).not.toHaveBeenCalled();
    expect(akun.hapusAkun).not.toHaveBeenCalled();
  });

  it('returns the profile of the token owner only', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(akun.profil).toHaveBeenCalledWith(mhs.id);
  });

  it('updates the display name and rejects unknown or SSO-owned fields', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/me').set('Authorization', bearer('MAHASISWA'))
      .send({ nama_tampilan: '  Budi  ' }).expect(200);
    expect(akun.ubahProfil).toHaveBeenCalledWith(mhs.id, { nama_tampilan: 'Budi' });

    for (const body of [{ nim: '999' }, { email: 'x@y.z' }, { nama_tampilan: '' }, { nama_tampilan: 'a'.repeat(61) }]) {
      await request(app.getHttpServer())
        .patch('/api/v1/me').set('Authorization', bearer('MAHASISWA')).send(body).expect(400);
    }
    expect(akun.ubahProfil).toHaveBeenCalledTimes(1);
  });

  it('allows clearing the display name with null', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/me').set('Authorization', bearer('MAHASISWA'))
      .send({ nama_tampilan: null }).expect(200);
    expect(akun.ubahProfil).toHaveBeenCalledWith(mhs.id, { nama_tampilan: null });
  });

  it('exports data as a non-cacheable attachment', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me/export').set('Authorization', bearer('MAHASISWA')).expect(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(akun.ekspor).toHaveBeenCalledWith(mhs.id, expect.objectContaining({ ip: expect.any(String) }));
  });

  it('requires explicit confirmation to delete the account and clears the refresh cookie', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/me').set('Authorization', bearer('MAHASISWA')).send({}).expect(400);
    await request(app.getHttpServer())
      .delete('/api/v1/me').set('Authorization', bearer('MAHASISWA')).send({ konfirmasi: 'ya' }).expect(400);
    expect(akun.hapusAkun).not.toHaveBeenCalled();

    const response = await request(app.getHttpServer())
      .delete('/api/v1/me').set('Authorization', bearer('MAHASISWA')).send({ konfirmasi: 'HAPUS' }).expect(204);
    expect(akun.hapusAkun).toHaveBeenCalledWith(mhs.id, expect.any(Object));
    expect(response.headers['set-cookie'][0]).toMatch(/^refresh_token=;/);
  });

  it('validates and normalizes emergency contacts', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/me/kontak-darurat').set('Authorization', bearer('MAHASISWA'))
      .send({ nama_kontak: ' Ibu ', no_telepon: '0812-3456 7890', hubungan: 'Orang tua' }).expect(201);
    expect(akun.tambahKontak).toHaveBeenCalledWith(mhs.id, {
      nama_kontak: 'Ibu', no_telepon: '081234567890', hubungan: 'Orang tua',
    });

    for (const body of [
      { nama_kontak: 'Ibu', no_telepon: '12' },
      { nama_kontak: 'Ibu', no_telepon: 'bukan-nomor' },
      { nama_kontak: '', no_telepon: '081234567890' },
      { nama_kontak: 'Ibu', no_telepon: '081234567890', id_mahasiswa: TEST_USERS.PSIKOLOG.id },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/me/kontak-darurat').set('Authorization', bearer('MAHASISWA')).send(body).expect(400);
    }
    expect(akun.tambahKontak).toHaveBeenCalledTimes(1);
  });

  it('scopes contact updates and deletes to the owner and validates the id', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/me/kontak-darurat/${kontakId}`).set('Authorization', bearer('MAHASISWA'))
      .send({ hubungan: null }).expect(200);
    expect(akun.ubahKontak).toHaveBeenCalledWith(mhs.id, kontakId, { hubungan: null });

    await request(app.getHttpServer())
      .delete(`/api/v1/me/kontak-darurat/${kontakId}`).set('Authorization', bearer('MAHASISWA')).expect(204);
    expect(akun.hapusKontak).toHaveBeenCalledWith(mhs.id, kontakId);

    await request(app.getHttpServer())
      .delete('/api/v1/me/kontak-darurat/not-a-uuid').set('Authorization', bearer('MAHASISWA')).expect(400);
  });
});
