import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { CirclePendampingService } from './circle-pendamping.service';
import { CirclePesanService } from './circle-pesan.service';

describe('CirclePendampingService (SCRUM-267)', () => {
  const psi = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const idCircle = '99999999-9999-4999-8999-999999999999';
  const idPesan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let circle: Record<string, unknown> | null;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let pesan: { daftar: jest.Mock; kirim: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: CirclePendampingService;

  beforeEach(() => {
    circle = { id_circle: idCircle, nama_circle: 'Akademik', kuota: 8, status: 'AKTIF', id_kategori: 'k', nama_kategori: 'Akademik', jumlah_anggota: 4 };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('c.id_psikolog = $2')) return { rows: circle ? [circle] : [] };
      if (sql.includes('UPDATE circle_pesan')) return { rows: [{ id_pesan: idPesan, disembunyikan: true, alasan_moderasi: 'x' }] };
      if (sql.includes('FROM keanggotaan_circle k')) return { rows: [{ nama: 'Anggota-ABCD', anonim: true }] };
      return { rows: [] };
    });
    client = { query, release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client), query };
    pesan = { daftar: jest.fn().mockResolvedValue([]), kirim: jest.fn().mockResolvedValue('p1') };
    audit = { catat: jest.fn() };
    service = new CirclePendampingService(pool as unknown as Pool, pesan as unknown as CirclePesanService, audit as unknown as AuditService);
  });

  it('only gives access to circles assigned to this psychologist (others look non-existent)', async () => {
    circle = null;
    await expect(service.detail(psi, idCircle)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.daftarPesan(psi, idCircle)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.sembunyikan(psi, idCircle, idPesan, 'Melanggar aturan', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.catat).not.toHaveBeenCalled();
  });

  it('shows members by alias (anonymity is kept towards the companion) and hidden content for review', async () => {
    const detail = await service.detail(psi, idCircle);
    expect(detail.anggota).toEqual([{ nama: 'Anggota-ABCD', anonim: true }]);
    await service.daftarPesan(psi, idCircle);
    expect(pesan.daftar).toHaveBeenCalledWith(idCircle, { tipe: 'PSIKOLOG', id: psi.id }, undefined, undefined);
  });

  it('hides a message with a reason and audits it; restoring is audited too', async () => {
    await service.sembunyikan(psi, idCircle, idPesan, 'Melanggar aturan', { ip: '1.1.1.1' });
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE circle_pesan'))!;
    expect(update[1]).toEqual([idPesan, idCircle, true, 'Melanggar aturan']);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'CIRCLE_MODERASI', resourceId: idPesan, metadata: { id_circle: idCircle, aksi: 'SEMBUNYIKAN' },
    }), client);

    await service.pulihkan(psi, idCircle, idPesan, {});
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE circle_pesan'))[1][1])
      .toEqual([idPesan, idCircle, false, null]);
  });

  it('posts as companion only in active circles', async () => {
    await expect(service.kirimPesan(psi, idCircle, 'Halo')).resolves.toEqual({ id_pesan: 'p1' });
    expect(pesan.kirim).toHaveBeenCalledWith(client, idCircle, { tipe: 'PSIKOLOG', id: psi.id }, 'Halo');
    circle = { ...circle!, status: 'DITUTUP' };
    await expect(service.kirimPesan(psi, idCircle, 'Halo')).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 404 when moderating a message outside the circle', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('c.id_psikolog = $2')) return { rows: [circle] };
      return { rows: [] };
    });
    await expect(service.sembunyikan(psi, idCircle, idPesan, 'x x x', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
