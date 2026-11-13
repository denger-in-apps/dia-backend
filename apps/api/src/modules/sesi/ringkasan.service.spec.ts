import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { RingkasanService } from './ringkasan.service';

describe('RingkasanService', () => {
  const mhs = { id: '11111111-1111-4111-8111-111111111111', role: 'MAHASISWA' as const };
  const psi = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const aad = `sesi_konseling:catatan_ringkasan_enc:${idSesi}`;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let current: Record<string, unknown> | null;
  let service: RingkasanService;

  beforeEach(() => {
    current = { status_sesi: 'SELESAI', consent_catatan: true, ada: false };
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return { rows: current ? [current] : [] };
        if (sql.includes('RETURNING id_sesi::text AS id_sesi, consent_catatan')) {
          return { rows: [{ id_sesi: idSesi, consent_catatan: false, consent_at: new Date() }] };
        }
        if (sql.includes('RETURNING updated_at')) return { rows: [{ updated_at: new Date() }] };
        return { rows: [] };
      }),
    };
    pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn() };
    encryption = { encrypt: jest.fn(() => Buffer.from('enc')), decrypt: jest.fn(() => Buffer.from('Ringkasan rahasia')) };
    service = new RingkasanService(
      pool as unknown as Pool,
      encryption as unknown as EncryptionService,
      audit as unknown as AuditService,
    );
  });

  const clientCall = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  describe('consent', () => {
    it('withdrawing consent also deletes the summary and is audited', async () => {
      await service.aturConsent(mhs, idSesi, false, {});
      const [sql, params] = clientCall('SET consent_catatan')!;
      expect(sql).toContain('catatan_ringkasan_enc = CASE WHEN $2 THEN catatan_ringkasan_enc END');
      expect(params).toEqual([idSesi, false]);
      expect(clientCall('id_mahasiswa = $2 FOR UPDATE')![1]).toEqual([idSesi, mhs.id]);
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SESI_CONSENT_TARIK' }), client);
    });

    it('does not audit when the value does not change', async () => {
      await service.aturConsent(mhs, idSesi, true, {});
      expect(audit.catat).not.toHaveBeenCalled();
    });

    it('rejects consent for cancelled sessions and unknown sessions', async () => {
      current = { status_sesi: 'DIBATALKAN', consent_catatan: false };
      await expect(service.aturConsent(mhs, idSesi, true, {})).rejects.toBeInstanceOf(ConflictException);
      current = null;
      await expect(service.aturConsent(mhs, idSesi, true, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ringkasan', () => {
    it('encrypts the summary bound to the row and audits CREATE vs UPDATE', async () => {
      await service.simpan(psi, idSesi, 'Ringkasan rahasia', {});
      expect(encryption.encrypt).toHaveBeenCalledWith('Ringkasan rahasia', aad);
      expect(clientCall('id_psikolog = $2 FOR UPDATE')![1]).toEqual([idSesi, psi.id]);
      expect(clientCall('SET catatan_ringkasan_enc')![1]).toEqual([idSesi, Buffer.from('enc')]);
      expect(audit.catat).toHaveBeenLastCalledWith(expect.objectContaining({ aksi: 'SESI_RINGKASAN_CREATE' }), client);

      current = { status_sesi: 'SELESAI', consent_catatan: true, ada: true };
      await service.simpan(psi, idSesi, 'Revisi', {});
      expect(audit.catat).toHaveBeenLastCalledWith(expect.objectContaining({ aksi: 'SESI_RINGKASAN_UPDATE' }), client);
    });

    it('refuses without consent (403 CONSENT_BELUM_ADA) and before the session runs', async () => {
      current = { status_sesi: 'SELESAI', consent_catatan: false, ada: false };
      const error = await service.simpan(psi, idSesi, 'x', {}).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse().kode).toBe('CONSENT_BELUM_ADA');
      expect(clientCall('SET catatan_ringkasan_enc')).toBeUndefined();

      current = { status_sesi: 'DIJADWALKAN', consent_catatan: true, ada: false };
      const early = await service.simpan(psi, idSesi, 'x', {}).catch((e) => e);
      expect(early.getResponse().kode).toBe('SESI_BELUM_BERLANGSUNG');
    });

    it('reads the summary for the session psychologist only, audited', async () => {
      pool.query.mockResolvedValue({ rows: [{ consent_catatan: true, catatan_ringkasan_enc: Buffer.from('enc'), updated_at: new Date() }] });
      const hasil = await service.baca(psi, idSesi, { ip: '1.1.1.1' });
      expect(hasil.ringkasan).toBe('Ringkasan rahasia');
      expect(pool.query.mock.calls[0][0]).toContain('id_psikolog = $2');
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SESI_RINGKASAN_READ', resourceId: idSesi }));

      pool.query.mockResolvedValue({ rows: [] });
      await expect(service.baca(psi, idSesi, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('riwayat', () => {
    it('denies history of students the psychologist never handled, and audits the denial', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      const error = await service.riwayatMahasiswa(psi, mhs.id, {}).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse().kode).toBe('BUKAN_MAHASISWA_DAMPINGAN');
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'RIWAYAT_SESI_READ', hasil: 'DITOLAK' }));
      expect(pool.query.mock.calls[0][0]).toContain(`('BERLANGSUNG', 'SELESAI')`);
    });

    it("returns all sessions as metadata but only decrypts this psychologist's consented summaries", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            { id_sesi: idSesi, milik_saya: true, consent_catatan: true, catatan_ringkasan_enc: Buffer.from('enc') },
            { id_sesi: 'lain', milik_saya: false, consent_catatan: true, catatan_ringkasan_enc: null },
          ],
        });
      const hasil = await service.riwayatMahasiswa(psi, mhs.id, {});
      const sql = pool.query.mock.calls[1][0];
      expect(sql).toContain('CASE WHEN s.id_psikolog = $1::uuid AND s.consent_catatan THEN s.catatan_ringkasan_enc END');
      expect(hasil[0].ringkasan).toBe('Ringkasan rahasia');
      expect(hasil[1].ringkasan).toBeNull();
      expect(hasil[0]).not.toHaveProperty('catatan_ringkasan_enc');
      expect(encryption.decrypt).toHaveBeenCalledTimes(1);
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'RIWAYAT_SESI_READ', metadata: { jumlah_sesi: 2 } }));
    });

    it('lists students handled by the psychologist', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await service.daftarDampingan(psi);
      expect(pool.query.mock.calls[0][1]).toEqual([psi.id]);
    });
  });
});
