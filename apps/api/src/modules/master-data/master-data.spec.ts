import { ConflictException, INestApplication, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { AuditService } from '../../common/audit/audit.service';
import { authGuardProviders, bearer, TEST_USERS } from '../../testing/auth-test.helper';
import { MasterDataController } from './master-data.controller';
import { BuatTemplateDto } from './master-data.dto';
import { MasterDataService } from './master-data.service';

const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const opsi = [0, 1, 2, 3].map((nilai) => ({ nilai, label: `Opsi ${nilai}` }));
const template = (kode: 'PHQ9' | 'GAD7', jumlah: number): BuatTemplateDto => ({
  kode,
  nama: `${kode} v2`,
  butir: {
    pertanyaan_pembuka: 'Selama 2 minggu terakhir ...',
    butir: Array.from({ length: jumlah }, (_, i) => ({ no: i + 1, teks: `Butir ${i + 1}` })),
    opsi,
  },
});

describe('MasterDataService (SCRUM-275)', () => {
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: MasterDataService;
  let row: Record<string, unknown> | null;
  let dipakai: number;

  beforeEach(() => {
    row = { kode: 'PHQ9', versi: 2, aktif: false };
    dipakai = 0;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM template_kuesioner WHERE id_template = $1 FOR UPDATE')) return { rows: row ? [row] : [] };
        if (sql.includes('FROM kategori_minat WHERE id_kategori = $1 FOR UPDATE')) return { rows: row ? [{}] : [], rowCount: row ? 1 : 0 };
        if (sql.includes('count(*)::int AS jumlah')) return { rows: [{ jumlah: dipakai }] };
        if (sql.includes('INSERT INTO template_kuesioner')) return { rows: [{ id_template: id, versi: 2 }] };
        if (sql.includes('SET aktif = false')) return { rows: [{ id_template: 'lama' }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    audit = { catat: jest.fn() };
    service = new MasterDataService(pool as unknown as Pool, audit as unknown as AuditService);
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  describe('template kuesioner', () => {
    it('creates the next version as inactive under a per-code lock, owned by the admin', async () => {
      const hasil = await service.buatTemplate(admin, template('PHQ9', 9), {});
      expect(hasil).toEqual({ id_template: id, kode: 'PHQ9', versi: 2, aktif: false });
      expect(call('pg_advisory_xact_lock')![1]).toEqual(['template:PHQ9']);
      const [sql, params] = call('INSERT INTO template_kuesioner')!;
      expect(sql).toContain('COALESCE(max(versi), 0) + 1');
      expect(params[3]).toBe(admin.id);
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'TEMPLATE_KUESIONER_BUAT' }), client);
    });

    it.each([
      [template('PHQ9', 8), 'BUTIR_TIDAK_VALID'],
      [template('GAD7', 9), 'BUTIR_TIDAK_VALID'],
      [{ ...template('GAD7', 7), butir: { ...template('GAD7', 7).butir, butir: template('GAD7', 7).butir.butir.map((b, i) => ({ ...b, no: i === 0 ? 2 : b.no })) } }, 'BUTIR_TIDAK_VALID'],
      [{ ...template('GAD7', 7), butir: { ...template('GAD7', 7).butir, opsi: [0, 1, 2, 2].map((nilai) => ({ nilai, label: 'x' })) } }, 'OPSI_TIDAK_VALID'],
    ])('rejects content that would break scoring (%#)', async (dto, kode) => {
      const error = await service.buatTemplate(admin, dto as BuatTemplateDto, {}).catch((e) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().kode).toBe(kode);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('activates a version by deactivating the others of the same code first', async () => {
      await service.aktifkanTemplate(admin, id, {});
      const urutan = client.query.mock.calls.map(([sql]) => String(sql));
      const nonaktif = urutan.findIndex((s) => s.includes('SET aktif = false'));
      const aktif = urutan.findIndex((s) => s.includes('SET aktif = true'));
      expect(nonaktif).toBeGreaterThan(-1);
      expect(aktif).toBeGreaterThan(nonaktif);
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
        aksi: 'TEMPLATE_KUESIONER_AKTIFKAN', metadata: { kode: 'PHQ9', versi: 2, menggantikan: ['lama'] },
      }), client);
    });

    it('refuses to delete the active version or one already used by results', async () => {
      row = { kode: 'PHQ9', versi: 1, aktif: true };
      let error = await service.hapusTemplate(admin, id, {}).catch((e) => e);
      expect(error.getResponse().kode).toBe('TEMPLATE_AKTIF');
      row = { kode: 'PHQ9', versi: 1, aktif: false };
      dipakai = 3;
      error = await service.hapusTemplate(admin, id, {}).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().kode).toBe('TEMPLATE_DIPAKAI');
      expect(call('DELETE FROM template_kuesioner')).toBeUndefined();
    });
  });

  describe('kategori minat', () => {
    it('deletes unused categories together with student preferences, audited', async () => {
      await service.hapusKategori(admin, id, {});
      expect(call('DELETE FROM preferensi_minat')![1]).toEqual([id]);
      expect(call('DELETE FROM kategori_minat')).toBeDefined();
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'KATEGORI_MINAT_HAPUS' }), client);
    });

    it('refuses deleting categories used by circles (deactivate instead)', async () => {
      dipakai = 2;
      const error = await service.hapusKategori(admin, id, {}).catch((e) => e);
      expect(error.getResponse().kode).toBe('KATEGORI_DIPAKAI');
      expect(call('DELETE FROM kategori_minat')).toBeUndefined();
    });

    it('maps duplicate names to 409', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO kategori_minat')) throw Object.assign(new Error('dup'), { code: '23505' });
        return { rows: [] };
      });
      const error = await service.buatKategori(admin, 'Akademik', {}).catch((e) => e);
      expect(error.getResponse().kode).toBe('KATEGORI_SUDAH_ADA');
    });
  });
});

describe('MasterDataController', () => {
  let app: INestApplication;
  let master: Record<string, jest.Mock>;

  beforeEach(async () => {
    master = Object.fromEntries(
      ['daftarKategori', 'buatKategori', 'ubahKategori', 'hapusKategori', 'daftarTemplate', 'detailTemplate', 'buatTemplate', 'aktifkanTemplate', 'hapusTemplate']
        .map((n) => [n, jest.fn().mockResolvedValue({})]),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [MasterDataController],
      providers: [{ provide: MasterDataService, useValue: master }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('restricts master data to Dosen Admin', async () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).post('/api/v1/admin/kategori-minat').set('Authorization', bearer(role)).send({ nama: 'Akademik' }).expect(403);
      await request(app.getHttpServer()).get('/api/v1/admin/template-kuesioner').set('Authorization', bearer(role)).expect(403);
    }
  });

  it('validates nested template content and activates versions', async () => {
    await request(app.getHttpServer()).post('/api/v1/admin/template-kuesioner').set('Authorization', bearer('DOSEN_ADMIN'))
      .send({ ...template('PHQ9', 9), butir: { ...template('PHQ9', 9).butir, opsi: [{ nilai: 4, label: 'x' }, ...opsi.slice(1)] } }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/admin/template-kuesioner').set('Authorization', bearer('DOSEN_ADMIN'))
      .send(template('PHQ9', 9)).expect(201);
    expect(master.buatTemplate).toHaveBeenCalledWith(TEST_USERS.DOSEN_ADMIN, expect.objectContaining({ kode: 'PHQ9' }), expect.any(Object));
    await request(app.getHttpServer()).post(`/api/v1/admin/template-kuesioner/${id}/aktifkan`).set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/admin/kategori-minat/${id}`).set('Authorization', bearer('DOSEN_ADMIN')).expect(204);
  });
});
