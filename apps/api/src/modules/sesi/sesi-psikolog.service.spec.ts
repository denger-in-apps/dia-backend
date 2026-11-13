import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { SesiPsikologService } from './sesi-psikolog.service';

describe('SesiPsikologService', () => {
  const psi = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const row = {
    id_sesi: idSesi, waktu_mulai: new Date(), waktu_selesai: new Date(), tipe_sesi: 'CHAT',
    status_sesi: 'DIJADWALKAN', consent_catatan: false, alasan_batal: null,
    id_mahasiswa: '11111111-1111-4111-8111-111111111111', nama_mahasiswa: 'Budi',
  };
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let encryption: { decrypt: jest.Mock };
  let service: SesiPsikologService;

  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue({ rows: [{ id_sesi: idSesi, status_sesi: 'BERLANGSUNG' }] }), release: jest.fn() };
    pool = { query: jest.fn().mockResolvedValue({ rows: [row] }), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn() };
    encryption = { decrypt: jest.fn(() => Buffer.from('Sulit tidur')) };
    service = new SesiPsikologService(
      pool as unknown as Pool,
      encryption as unknown as EncryptionService,
      audit as unknown as AuditService,
    );
  });

  const update = () => client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE sesi_konseling'))!;

  it('lists only sessions of the logged-in psychologist', async () => {
    const hasil = await service.daftar(psi, {});
    expect(pool.query.mock.calls[0][0]).toContain('s.id_psikolog = $1');
    expect(pool.query.mock.calls[0][1]).toEqual([psi.id, 50]);
    expect(hasil[0].mahasiswa).toEqual({ id: row.id_mahasiswa, nama: 'Budi' });
  });

  it('shows detail with the decrypted complaint and audits the read', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...row, nim: '2026001', keluhan_awal_enc: Buffer.from('x'), ada_ringkasan: false }] });
    const detail = await service.detail(psi, idSesi, { ip: '1.2.3.4' });
    expect(detail.keluhan_awal).toBe('Sulit tidur');
    expect(detail.mahasiswa).toEqual({ id: row.id_mahasiswa, nama: 'Budi', nim: '2026001' });
    expect(encryption.decrypt).toHaveBeenCalledWith(Buffer.from('x'), `sesi_konseling:keluhan_awal_enc:${idSesi}`);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SESI_DETAIL_READ', resourceId: idSesi }));
    expect(detail).not.toHaveProperty('keluhan_awal_enc');
  });

  it('returns 404 for sessions of other psychologists without auditing a read', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.detail(psi, idSesi, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.catat).not.toHaveBeenCalled();
  });

  it('starts a session only from DIJADWALKAN inside the time window, atomically', async () => {
    await service.ubahStatus(psi, idSesi, { status: 'BERLANGSUNG' }, {});
    const [sql, params] = update();
    expect(sql).toContain('make_interval(mins => $5::int)');
    expect(params).toEqual([idSesi, psi.id, 'BERLANGSUNG', 'DIJADWALKAN', 10]);
    expect(audit.catat).toHaveBeenCalledWith(
      expect.objectContaining({ aksi: 'SESI_STATUS_UBAH', metadata: { status: 'BERLANGSUNG' } }), client);
  });

  it.each([
    ['SELESAI', 'BERLANGSUNG'],
    ['TIDAK_HADIR', 'DIJADWALKAN'],
  ] as const)('moves to %s only from %s and sends no unused SQL params', async (target, dari) => {
    await service.ubahStatus(psi, idSesi, { status: target }, {});
    const [sql, params] = update();
    expect(params).toEqual([idSesi, psi.id, target, dari]);
    expect(sql).not.toContain('$5');
  });

  it.each([
    ['SELESAI', 'BERLANGSUNG', ConflictException, 'TRANSISI_TIDAK_VALID'],
    ['BERLANGSUNG', 'BERLANGSUNG', ConflictException, 'STATUS_SUDAH_SAMA'],
    ['DIJADWALKAN', 'BERLANGSUNG', UnprocessableEntityException, 'DI_LUAR_WAKTU_SESI'],
    ['DIJADWALKAN', 'TIDAK_HADIR', UnprocessableEntityException, 'DI_LUAR_WAKTU_SESI'],
  ] as const)('explains rejection when current status is %s and target %s', async (current, target, type, kode) => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE sesi_konseling')) return { rows: [] };
      if (sql.includes('SELECT status_sesi')) return { rows: [{ status_sesi: current }] };
      return { rows: [] };
    });
    const error = await service.ubahStatus(psi, idSesi, { status: target }, {}).catch((e) => e);
    expect(error).toBeInstanceOf(type);
    expect(error.getResponse().kode).toBe(kode);
    expect(audit.catat).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
