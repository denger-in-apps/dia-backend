import { BadRequestException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request = require('supertest');
import { configureApp } from '../../app.setup';
import { authGuardProviders, bearer } from '../../testing/auth-test.helper';
import { LaporanController } from './laporan.controller';
import { LaporanService, samarkan } from './laporan.service';

describe('LaporanService (SCRUM-274)', () => {
  let pool: { query: jest.Mock };
  let service: LaporanService;

  beforeEach(() => {
    pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    service = new LaporanService(pool as unknown as Pool);
  });

  it.each([[0, 0], [1, null], [4, null], [5, 5], ['12', 12], [null, 0]])('samarkan(%p) → %p', (n, hasil) => {
    expect(samarkan(n as number)).toBe(hasil);
  });

  it('reads only v_laporan_* views and hides small cells inside visible months', async () => {
    pool.query.mockResolvedValue({ rows: [{ bulan: '2026-10', total_sos: '12', total_eskalasi: '2' }] });
    const hasil = await service.genta('2026-01', '2026-10');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM v_laporan_genta_bulanan');
    expect(params).toEqual(['2026-01-01', '2026-11-01']);
    expect(hasil.data).toEqual([{ bulan: '2026-10', total_sos: 12, total_eskalasi: null }]);
    expect(hasil.total).toEqual({ total_sos: 12, total_eskalasi: 0 });
    expect(hasil.catatan).toContain('disembunyikan');
  });

  it('never queries base tables, for every report', async () => {
    await service.ringkasan('2026-01', '2026-06');
    for (const [sql] of pool.query.mock.calls) {
      expect(sql).toMatch(/FROM v_laporan_\w+/);
      expect(sql).not.toMatch(/FROM (log_sos|hasil_cek_mandiri|sesi_konseling|curhat_anonim|mahasiswa)\b/);
    }
    expect(pool.query).toHaveBeenCalledTimes(5);
  });

  it('aggregates PHQ-9/GAD-7 per level from visible cells only', async () => {
    pool.query.mockResolvedValue({
      rows: [
        { bulan: '2026-10', risiko_phq9: 'RINGAN', risiko_gad7: 'MINIMAL', jumlah: '7' },
        { bulan: '2026-10', risiko_phq9: 'RINGAN', risiko_gad7: null, jumlah: '5' },
        { bulan: '2026-10', risiko_phq9: null, risiko_gad7: 'SEDANG', jumlah: '6' },
      ],
    });
    const hasil = await service.cekMandiri();
    expect(hasil.total).toEqual({
      pengisian: 18,
      per_tingkat_phq9: { RINGAN: 12, TIDAK_DIISI: 6 },
      per_tingkat_gad7: { MINIMAL: 7, TIDAK_DIISI: 5, SEDANG: 6 },
    });
  });

  it('summarises circles per category with member counts hidden below 5', async () => {
    pool.query.mockResolvedValue({
      rows: [
        { kategori: 'Akademik', status: 'AKTIF', jumlah_circle: '2', jumlah_anggota: '11' },
        { kategori: 'Hobi', status: 'AKTIF', jumlah_circle: '1', jumlah_anggota: '3' },
      ],
    });
    const hasil = await service.circle();
    expect(hasil.data[1].jumlah_anggota).toBeNull();
    expect(hasil.total).toEqual({ circle_aktif: 3, anggota_circle_aktif: 11 });
  });

  it.each([
    ['2026-05', '2026-04'],
    ['2023-01', '2026-01'],
  ])('rejects invalid periods %s..%s', async (dari, sampai) => {
    await expect(service.genta(dari, sampai)).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('defaults to the last 12 months and handles year boundaries', async () => {
    await service.sesi(undefined, '2026-02');
    expect(pool.query.mock.calls[0][1]).toEqual(['2025-03-01', '2026-03-01']);
    await service.curhat('2026-12', '2026-12');
    expect(pool.query.mock.calls[1][1]).toEqual(['2026-12-01', '2027-01-01']);
  });
});

describe('LaporanController', () => {
  let app: INestApplication;
  let laporan: Record<string, jest.Mock>;

  beforeEach(async () => {
    laporan = Object.fromEntries(['ringkasan', 'genta', 'cekMandiri', 'sesi', 'curhat', 'circle'].map((n) => [n, jest.fn().mockResolvedValue({})]));
    const moduleRef = await Test.createTestingModule({
      controllers: [LaporanController],
      providers: [{ provide: LaporanService, useValue: laporan }, ...authGuardProviders()],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app.close());

  it('is only for Dosen Admin and validates the month format', async () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG'] as const) {
      await request(app.getHttpServer()).get('/api/v1/admin/laporan/ringkasan').set('Authorization', bearer(role)).expect(403);
    }
    await request(app.getHttpServer()).get('/api/v1/admin/laporan/genta?dari=2026-13').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
    await request(app.getHttpServer()).get('/api/v1/admin/laporan/cek-mandiri?dari=2026-01&sampai=2026-06')
      .set('Authorization', bearer('DOSEN_ADMIN')).expect(200);
    expect(laporan.cekMandiri).toHaveBeenCalledWith('2026-01', '2026-06');
    await request(app.getHttpServer()).get('/api/v1/admin/laporan/genta?id_mahasiswa=x').set('Authorization', bearer('DOSEN_ADMIN')).expect(400);
  });
});
