import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { CircleAdminController } from './circle-admin.controller';
import { CircleAdminService } from './circle-admin.service';

describe('CircleAdminController', () => {
  let app: INestApplication;
  let circle: Record<string, jest.Mock>;
  const id = '99999999-9999-4999-8999-999999999999';
  const idPsi = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    circle = Object.fromEntries(
      ['daftar', 'buat', 'detail', 'ubah', 'setujui', 'tolak', 'tutup', 'daftarKategori', 'buatKategori', 'ubahKategori']
        .map((name) => [name, jest.fn().mockResolvedValue({})]),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [CircleAdminController],
      providers: [{ provide: CircleAdminService, useValue: circle }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('restricts circle approval and categories to Dosen Admin', async () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).post(`/api/v1/admin/circles/${id}/setujui`).set('Authorization', bearer(role))
        .send({ id_psikolog: idPsi }).expect(403);
      await request(app.getHttpServer()).post('/api/v1/admin/kategori-minat').set('Authorization', bearer(role))
        .send({ nama: 'Akademik' }).expect(403);
    }
    expect(circle.setujui).not.toHaveBeenCalled();
  });

  it('approves with a companion and rejects with a reason', async () => {
    await request(app.getHttpServer()).post(`/api/v1/admin/circles/${id}/setujui`).set('Authorization', bearer('DOSEN_ADMIN'))
      .send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/admin/circles/${id}/setujui`).set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ id_psikolog: idPsi }).expect(200);
    expect(circle.setujui).toHaveBeenCalledWith(TEST_USERS.DOSEN_ADMIN, id, idPsi, expect.any(Object));
    await request(app.getHttpServer()).post(`/api/v1/admin/circles/${id}/tolak`).set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ alasan: '' }).expect(400);
    await request(app.getHttpServer()).get('/api/v1/admin/circles?status=DIAJUKAN').set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    expect(circle.daftar).toHaveBeenCalledWith({ status: 'DIAJUKAN' });
  });
});
