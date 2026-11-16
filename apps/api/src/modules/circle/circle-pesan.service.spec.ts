import { HttpException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CirclePesanService } from './circle-pesan.service';

describe('CirclePesanService', () => {
  const idCircle = '99999999-9999-4999-8999-999999999999';
  const rows = [
    { id_pesan: 'p2', created_at: new Date(2), nama_pengirim: 'Pendamping (Psi A)', dari_psikolog: true, milik_saya: false,
      isi: 'Halo semua', disembunyikan: false, alasan_moderasi: null },
    { id_pesan: 'p1', created_at: new Date(1), nama_pengirim: 'Anggota-ABCD', dari_psikolog: false, milik_saya: true,
      isi: 'kata kasar', disembunyikan: true, alasan_moderasi: 'Melanggar aturan' },
  ];

  it('shows messages oldest-first, hiding moderated content from members but not from the companion', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: rows.map((r) => ({ ...r })) }) };
    const service = new CirclePesanService(pool as unknown as Pool);
    const untukAnggota = await service.daftar(idCircle, { tipe: 'MAHASISWA', id: 'm' });
    expect(untukAnggota.map((p) => p.id_pesan)).toEqual(['p1', 'p2']);
    expect(untukAnggota[0]).toMatchObject({ isi: null, disembunyikan: true, alasan_moderasi: 'Melanggar aturan' });
    expect(untukAnggota[1].pengirim).toEqual({ tipe: 'PENDAMPING', nama: 'Pendamping (Psi A)', milik_saya: false });
    expect(pool.query.mock.calls[0][1]).toEqual([idCircle, 'm', 'MAHASISWA', null, 50]);

    pool.query.mockResolvedValue({ rows: rows.map((r) => ({ ...r })) });
    const untukPendamping = await service.daftar(idCircle, { tipe: 'PSIKOLOG', id: 'p' });
    expect(untukPendamping[0].isi).toBe('kata kasar');
  });

  it('rate-limits messages per sender per minute', async () => {
    const service = new CirclePesanService({} as Pool);
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ jumlah: 20 }] }) };
    await expect(service.kirim(client as unknown as PoolClient, idCircle, { tipe: 'MAHASISWA', id: 'm' }, 'x'))
      .rejects.toBeInstanceOf(HttpException);
    expect(client.query).toHaveBeenCalledTimes(1);

    client.query.mockResolvedValueOnce({ rows: [{ jumlah: 0 }] }).mockResolvedValueOnce({ rows: [{ id_pesan: 'p9' }] });
    await expect(service.kirim(client as unknown as PoolClient, idCircle, { tipe: 'PSIKOLOG', id: 'p' }, 'x')).resolves.toBe('p9');
    expect(client.query.mock.calls[2][0]).toContain('(id_circle, id_psikolog, isi)');
  });
});
