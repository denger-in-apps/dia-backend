import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AuditService } from '../../common/audit/audit.service';
import { GentaPsikologService } from './genta-psikolog.service';
import { SosLokasiService } from './sos-lokasi.service';

describe('GentaPsikologService — lokasi SOS', () => {
  const psikolog = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const idSos = '55555555-5555-4555-8555-555555555555';
  let lokasi: SosLokasiService;
  let pool: { query: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: GentaPsikologService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    lokasi = new SosLokasiService(new EncryptionService());
  });

  beforeEach(() => {
    pool = { query: jest.fn() };
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    service = new GentaPsikologService(pool as unknown as Pool, lokasi, audit as unknown as AuditService);
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id_psikolog: psikolog.id,
    status_penanganan: 'DIAMBIL',
    lokasi_izin: true,
    koordinat_lokasi_enc: lokasi.enkripsi(idSos, { lat: -6.9, lng: 107.6, akurasi_m: 20 }),
    lokasi_diperbarui_at: new Date(),
    ...overrides,
  });

  it('returns the decrypted location to the assigned psychologist and audits the read', async () => {
    pool.query.mockResolvedValue({ rows: [row()] });

    const result = await service.lokasiSos(psikolog, idSos, { ip: '10.0.0.2' });

    expect(result).toMatchObject({ id_sos: idSos, lat: -6.9, lng: 107.6, akurasi_m: 20 });
    expect(result.peta_url).toContain('mlat=-6.9');
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'SOS_LOKASI_READ', resourceId: idSos, aktor: psikolog, ip: '10.0.0.2',
    }));
    expect(audit.catat.mock.calls[0][0].hasil).toBeUndefined();
  });

  it.each([
    ['another psychologist', { id_psikolog: '99999999-9999-4999-8999-999999999999' }],
    ['an untaken case', { id_psikolog: null, status_penanganan: 'BARU' }],
    ['a finished case', { status_penanganan: 'SELESAI' }],
  ])('denies and audits access by %s', async (_label, overrides) => {
    pool.query.mockResolvedValue({ rows: [row(overrides)] });
    await expect(service.lokasiSos(psikolog, idSos, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SOS_LOKASI_READ', hasil: 'DITOLAK' }));
  });

  it('reports when the student did not share a location', async () => {
    pool.query.mockResolvedValue({ rows: [row({ lokasi_izin: false, koordinat_lokasi_enc: null })] });
    await expect(service.lokasiSos(psikolog, idSos, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 for an unknown SOS', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.lokasiSos(psikolog, idSos, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.catat).not.toHaveBeenCalled();
  });
});
