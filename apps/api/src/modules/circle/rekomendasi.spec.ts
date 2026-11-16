import { UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { KandidatCircle, rekomendasikan } from './rekomendasi';
import { RekomendasiService } from './rekomendasi.service';

const kandidat = (o: Partial<KandidatCircle>): KandidatCircle => ({
  id_circle: o.nama_circle ?? 'x', nama_circle: 'x', nama_kategori: 'Akademik', kuota: 8, jumlah_anggota: 4,
  pesan_14_hari: 0, minat_cocok: false, ...o,
});

describe('Mesin rekomendasi Circle (SCRUM-266)', () => {
  it('ranks matching interests first, then free seats and activity, and skips full circles', () => {
    const hasil = rekomendasikan([
      kandidat({ nama_circle: 'Ramai', jumlah_anggota: 2, pesan_14_hari: 40 }),
      kandidat({ nama_circle: 'Cocok', minat_cocok: true, jumlah_anggota: 7 }),
      kandidat({ nama_circle: 'Penuh', minat_cocok: true, jumlah_anggota: 8 }),
      kandidat({ nama_circle: 'Sepi', jumlah_anggota: 2 }),
    ], 5);
    expect(hasil.map((r) => r.nama_circle)).toEqual(['Cocok', 'Ramai', 'Sepi']);
    expect(hasil[0]).toMatchObject({ skor: 3.125, sisa_kuota: 1 });
    expect(hasil[0].alasan).toEqual(['Sesuai minat Anda: Akademik', 'Masih ada 1 tempat']);
    expect(hasil[1].skor).toBe(1.75);
    expect(hasil[1].alasan).toContain('Aktif dalam 2 minggu terakhir');
  });

  it('respects the limit and breaks ties by name', () => {
    const hasil = rekomendasikan([kandidat({ nama_circle: 'B' }), kandidat({ nama_circle: 'A' }), kandidat({ nama_circle: 'C' })], 2);
    expect(hasil.map((r) => r.nama_circle)).toEqual(['A', 'B']);
  });
});

describe('RekomendasiService', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  const k1 = '55555555-5555-4555-8555-555555555555';

  it('replaces preferences atomically with active categories only (max 5)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ jumlah: 1 }] }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new RekomendasiService(pool as unknown as Pool);
    await service.simpanPreferensi(idMhs, [k1, k1]);
    const sqls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => s.includes('DELETE FROM preferensi_minat'))).toBe(true);
    expect(client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO preferensi_minat'))![1]).toEqual([idMhs, [k1]]);

    client.query.mockResolvedValue({ rows: [{ jumlah: 0 }] });
    await expect(service.simpanPreferensi(idMhs, [k1])).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.simpanPreferensi(idMhs, ['1', '2', '3', '4', '5', '6'])).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('excludes joined circles and asks for preferences when none are set', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => (sql.includes('AS ada') ? { rows: [{ ada: false }] } : { rows: [kandidat({ nama_circle: 'A' })] })),
    };
    const service = new RekomendasiService(pool as unknown as Pool);
    const hasil = await service.rekomendasi(idMhs);
    expect(hasil.butuh_preferensi).toBe(true);
    expect(hasil.rekomendasi).toHaveLength(1);
    const sql = pool.query.mock.calls.find(([s]) => String(s).includes('FROM circle c'))![0];
    expect(sql).toContain("c.status = 'AKTIF'");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM keanggotaan_circle k');
    expect(sql).toContain('NOT cp.disembunyikan');
  });
});
