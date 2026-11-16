import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { CirclePesanService } from './circle-pesan.service';
import { CircleService } from './circle.service';

describe('CircleService — mahasiswa (SCRUM-263)', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  const idCircle = '99999999-9999-4999-8999-999999999999';
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let pesan: { daftar: jest.Mock; kirim: jest.Mock };
  let circle: { status: string; kuota: number } | null;
  let sudahAnggota: boolean;
  let jumlah: { anggota: number; diikuti: number };
  let service: CircleService;

  beforeEach(() => {
    circle = { status: 'AKTIF', kuota: 8 };
    sudahAnggota = false;
    jumlah = { anggota: 3, diikuti: 0 };
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM circle WHERE id_circle = $1 FOR UPDATE')) return { rows: circle ? [circle] : [] };
        if (sql.includes('FROM keanggotaan_circle WHERE id_mahasiswa = $1 AND id_circle = $2')) {
          return { rows: sudahAnggota ? [{ id_circle: idCircle, alias_anonim: 'Anggota-AAAA', status_anonim: true }] : [] };
        }
        if (sql.includes('AS anggota')) return { rows: [jumlah] };
        if (sql.includes('SELECT alias_anonim FROM keanggotaan_circle')) return { rows: [{ alias_anonim: 'Anggota-BBBB' }] };
        if (sql.includes('INSERT INTO keanggotaan_circle')) {
          return { rows: [{ id_circle: params[1], alias_anonim: params[2], status_anonim: true, joined_at: new Date() }] };
        }
        if (sql.includes('FROM kategori_minat')) return { rows: [{}], rowCount: 1 };
        if (sql.includes("status = 'DIAJUKAN'") && sql.includes('count(*)')) return { rows: [{ jumlah: 0 }] };
        if (sql.includes('INSERT INTO circle')) return { rows: [{ id_circle: idCircle, status: 'DIAJUKAN' }] };
        if (sql.includes('SELECT c.status FROM circle c JOIN keanggotaan_circle')) {
          return { rows: sudahAnggota ? [{ status: circle?.status }] : [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    pesan = { daftar: jest.fn().mockResolvedValue([]), kirim: jest.fn().mockResolvedValue('p1') };
    service = new CircleService(pool as unknown as Pool, pesan as unknown as CirclePesanService);
  });

  const call = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  describe('gabung', () => {
    it('joins under a row lock with a unique anonymous alias (anonymous by default)', async () => {
      const hasil = await service.gabung(idMhs, idCircle);
      expect(call('FOR UPDATE')).toBeDefined();
      expect(hasil.baru).toBe(true);
      expect(hasil.alias_anonim).toMatch(/^Anggota-[0-9A-F]{4}$/);
      expect(hasil.alias_anonim).not.toBe('Anggota-BBBB');
      expect(hasil.status_anonim).toBe(true);
    });

    it('is idempotent for existing members', async () => {
      sudahAnggota = true;
      const hasil = await service.gabung(idMhs, idCircle);
      expect(hasil.baru).toBe(false);
      expect(call('INSERT INTO keanggotaan_circle')).toBeUndefined();
    });

    it.each([
      [() => { jumlah = { anggota: 8, diikuti: 0 }; }, ConflictException, 'CIRCLE_PENUH'],
      [() => { jumlah = { anggota: 1, diikuti: 5 }; }, UnprocessableEntityException, 'BATAS_KEANGGOTAAN'],
      [() => { circle = { status: 'DIAJUKAN', kuota: 8 }; }, ConflictException, 'CIRCLE_TIDAK_AKTIF'],
    ])('rejects joining (%#)', async (siapkan, type, kode) => {
      siapkan();
      const error = await service.gabung(idMhs, idCircle).catch((e) => e);
      expect(error).toBeInstanceOf(type);
      expect(error.getResponse().kode).toBe(kode);
      expect(call('INSERT INTO keanggotaan_circle')).toBeUndefined();
    });

    it('returns 404 for unknown circles', async () => {
      circle = null;
      await expect(service.gabung(idMhs, idCircle)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('only lets members leave, toggle anonymity, and use the chat', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.keluar(idMhs, idCircle)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.ubahAnonim(idMhs, idCircle, false)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.daftarPesan(idMhs, idCircle)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.kirimPesan(idMhs, idCircle, 'halo')).rejects.toBeInstanceOf(ForbiddenException);
    expect(pesan.kirim).not.toHaveBeenCalled();
  });

  it('posts to an active circle as the member, and refuses closed circles', async () => {
    sudahAnggota = true;
    await expect(service.kirimPesan(idMhs, idCircle, 'halo')).resolves.toEqual({ id_pesan: 'p1' });
    expect(pesan.kirim).toHaveBeenCalledWith(client, idCircle, { tipe: 'MAHASISWA', id: idMhs }, 'halo');
    circle = { status: 'DITUTUP', kuota: 8 };
    const error = await service.kirimPesan(idMhs, idCircle, 'halo').catch((e) => e);
    expect(error.getResponse().kode).toBe('CIRCLE_TIDAK_AKTIF');
  });

  it('hides the member list from non-members and hides non-active circles from outsiders', async () => {
    const row = { id_circle: idCircle, nama_circle: 'Akademik', kuota: 8, status: 'AKTIF', id_kategori: 'k', nama_kategori: 'Akademik',
      jumlah_anggota: 3, sudah_bergabung: false, diajukan_oleh_saya: false, alasan_penolakan: null };
    pool.query.mockResolvedValueOnce({ rows: [row] });
    const detail = await service.detail(idMhs, idCircle);
    expect(detail.anggota).toBeNull();
    expect(detail.sisa_kuota).toBe(5);

    pool.query.mockResolvedValueOnce({ rows: [{ ...row, status: 'DITOLAK' }] });
    await expect(service.detail(idMhs, idCircle)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('submits a proposal as DIAJUKAN with a valid category and a pending limit', async () => {
    await service.ajukan(idMhs, { nama_circle: 'Pejuang Skripsi', id_kategori: 'k' });
    expect(call('INSERT INTO circle')![1]).toEqual(['Pejuang Skripsi', null, 'k', 8, idMhs]);

    client.query.mockImplementation(async (sql: string) => (sql.includes('FROM kategori_minat') ? { rows: [], rowCount: 0 } : { rows: [] }));
    const error = await service.ajukan(idMhs, { nama_circle: 'X', id_kategori: 'k' }).catch((e) => e);
    expect(error.getResponse().kode).toBe('KATEGORI_TIDAK_VALID');
  });
});
