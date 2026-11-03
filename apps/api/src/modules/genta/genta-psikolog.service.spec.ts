import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AuditService } from '../../common/audit/audit.service';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { GentaPsikologService } from './genta-psikolog.service';
import { SosLokasiService } from './sos-lokasi.service';

describe('GentaPsikologService', () => {
  const psikolog = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const lain = '99999999-9999-4999-8999-999999999999';
  const idSos = '55555555-5555-4555-8555-555555555555';
  let encryption: EncryptionService;
  let lokasi: SosLokasiService;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let notifikasi: { sosDiperbarui: jest.Mock };
  let service: GentaPsikologService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
    lokasi = new SosLokasiService(encryption);
  });

  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    notifikasi = { sosDiperbarui: jest.fn() };
    service = new GentaPsikologService(
      pool as unknown as Pool, lokasi, audit as unknown as AuditService, encryption,
      notifikasi as unknown as SosNotifikasiService,
    );
  });

  const sqlOf = (mock: jest.Mock, fragment: string) =>
    mock.mock.calls.find(([sql]) => String(sql).includes(fragment));

  describe('daftar (antrean)', () => {
    it('orders by priority then waiting time and only names students of my own cases', async () => {
      pool.query.mockResolvedValue({ rows: [{ situasi: 'DALAM_BAHAYA', prioritas: 'KRITIS' }] });

      const rows = await service.daftar(psikolog, {});

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('ORDER BY s.prioritas DESC, s.waktu_kejadian ASC');
      expect(sql).toContain("s.status_penanganan IN ('BARU', 'ESKALASI')");
      expect(sql).toContain('CASE WHEN s.id_psikolog = $1::uuid THEN COALESCE(m.nama_tampilan, m.nama) END');
      expect(sql).not.toMatch(/m\.nim|m\.email/);
      expect(params).toEqual([psikolog.id, 50]);
      expect(rows[0].situasi_label).toBe('Saya dalam bahaya / terancam orang lain');
    });

    it.each([
      ['antrean', "WHERE s.status_penanganan IN ('BARU', 'ESKALASI')"],
      ['milik_saya', "s.id_psikolog = $1::uuid AND s.status_penanganan IN ('DIAMBIL', 'DITANGANI')"],
      ['riwayat', "s.status_penanganan = 'SELESAI'"],
    ] as const)('filters scope %s', async (cakupan, fragment) => {
      pool.query.mockResolvedValue({ rows: [] });
      await service.daftar(psikolog, { cakupan, limit: 10 });
      expect(pool.query.mock.calls[0][0]).toContain(fragment);
      expect(pool.query.mock.calls[0][1]).toEqual([psikolog.id, 10]);
    });
  });

  describe('detail', () => {
    const detailRow = (overrides: Record<string, unknown>) => ({
      id_sos: idSos, situasi: 'SERANGAN_PANIK', status_penanganan: 'DIAMBIL', milik_saya: true,
      nim: '2026001', nama_asli: 'Budi', email: 'budi@kampus.ac.id', catatan_penanganan_enc: null,
      total_sos: 3, laporan_tidak_valid: 1, ...overrides,
    });

    it('shows identity, history and decrypted notes to the handling psychologist and audits it', async () => {
      const enc = encryption.encrypt('Sudah ditelepon', `log_sos:catatan_penanganan_enc:${idSos}`);
      pool.query.mockResolvedValue({ rows: [detailRow({ catatan_penanganan_enc: enc })] });

      const detail = await service.detail(psikolog, idSos, { ip: '10.0.0.3' });

      expect(detail.mahasiswa).toEqual({ nim: '2026001', nama: 'Budi', email: 'budi@kampus.ac.id' });
      expect(detail.riwayat_30_hari).toEqual({ total_sos: 3, laporan_tidak_valid: 1 });
      expect(detail.catatan_penanganan).toBe('Sudah ditelepon');
      expect(detail).not.toHaveProperty('catatan_penanganan_enc');
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SOS_DETAIL_READ', resourceId: idSos }));
    });

    it('hides identity for queued cases', async () => {
      pool.query.mockResolvedValue({ rows: [detailRow({ status_penanganan: 'BARU', milik_saya: false })] });
      const detail = await service.detail(psikolog, idSos, {});
      expect(detail.mahasiswa).toBeNull();
      expect(detail.riwayat_30_hari).toBeNull();
      expect(JSON.stringify(detail)).not.toMatch(/2026001|budi@kampus/);
      expect(audit.catat).not.toHaveBeenCalled();
    });

    it("forbids another psychologist's case and 404s unknown cases", async () => {
      pool.query.mockResolvedValueOnce({ rows: [detailRow({ milik_saya: false })] });
      await expect(service.detail(psikolog, idSos, {})).rejects.toBeInstanceOf(ForbiddenException);
      pool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.detail(psikolog, idSos, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ambil', () => {
    it('takes a queued case with one conditional UPDATE, audits it and broadcasts the change', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE log_sos')) {
          return { rows: [{ id_sos: idSos, status_penanganan: 'DIAMBIL', id_psikolog: psikolog.id }] };
        }
        return { rows: [] };
      });

      await expect(service.ambil(psikolog, idSos, {})).resolves.toMatchObject({ status_penanganan: 'DIAMBIL' });

      const [sql, params] = sqlOf(client.query, 'UPDATE log_sos')!;
      expect(sql).toContain("WHERE id_sos = $2 AND status_penanganan IN ('BARU', 'ESKALASI')");
      expect(params).toEqual([psikolog.id, idSos]);
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'SOS_AMBIL' }), client);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(notifikasi.sosDiperbarui).toHaveBeenCalledWith({
        id_sos: idSos, status_penanganan: 'DIAMBIL', id_psikolog: psikolog.id,
      });
    });

    it('returns 409 when another psychologist won the race', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE log_sos')) return { rows: [] };
        if (sql.includes('SELECT status_penanganan')) return { rows: [{ status_penanganan: 'DIAMBIL', id_psikolog: lain }] };
        return { rows: [] };
      });
      await expect(service.ambil(psikolog, idSos, {})).rejects.toBeInstanceOf(ConflictException);
      expect(audit.catat).not.toHaveBeenCalled();
      expect(notifikasi.sosDiperbarui).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('is idempotent when I already hold the case', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE log_sos')) return { rows: [] };
        if (sql.includes('SELECT status_penanganan')) {
          return { rows: [{ status_penanganan: 'DITANGANI', id_psikolog: psikolog.id }] };
        }
        return { rows: [] };
      });
      await expect(service.ambil(psikolog, idSos, {})).resolves.toMatchObject({ status_penanganan: 'DITANGANI' });
      expect(audit.catat).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown case', async () => {
      client.query.mockResolvedValue({ rows: [] });
      await expect(service.ambil(psikolog, idSos, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ubahStatus', () => {
    const updatedRow = (status: string) => ({ rows: [{ id_sos: idSos, status_penanganan: status, id_psikolog: psikolog.id }] });

    it('moves my case to DITANGANI with an encrypted note', async () => {
      client.query.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE log_sos') ? updatedRow('DITANGANI') : { rows: [] });

      await service.ubahStatus(psikolog, idSos, { status: 'DITANGANI', catatan: 'Menuju lokasi' }, {});

      const [sql, params] = sqlOf(client.query, 'UPDATE log_sos')!;
      expect(sql).toContain("WHERE id_sos = $1 AND id_psikolog = $2 AND status_penanganan IN ('DIAMBIL', 'DITANGANI')");
      expect(params.slice(0, 5)).toEqual([idSos, psikolog.id, 'DITANGANI', null, false]);
      expect(params[6]).toBe(false);
      expect(encryption.decrypt(params[5], `log_sos:catatan_penanganan_enc:${idSos}`).toString()).toBe('Menuju lokasi');
      expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
        aksi: 'SOS_STATUS_UBAH', metadata: { status: 'DITANGANI', laporan_tidak_valid: false },
      }), client);
      expect(notifikasi.sosDiperbarui).toHaveBeenCalledWith(expect.objectContaining({ status_penanganan: 'DITANGANI' }));
    });

    it('closes a case, clearing the location', async () => {
      client.query.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE log_sos') ? updatedRow('SELESAI') : { rows: [] });
      await service.ubahStatus(psikolog, idSos, { status: 'SELESAI' }, {});
      const [sql, params] = sqlOf(client.query, 'UPDATE log_sos')!;
      expect(sql).toContain('koordinat_lokasi_enc = CASE WHEN $7 THEN NULL');
      expect(params).toEqual([idSos, psikolog.id, 'SELESAI', 'DITANGANI', false, null, true]);
    });

    it('flags an invalid report so the abuse checks of PBI-05 can use it', async () => {
      client.query.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE log_sos') ? updatedRow('SELESAI') : { rows: [] });
      await service.ubahStatus(psikolog, idSos, {
        status: 'SELESAI', laporan_tidak_valid: true, catatan: 'Mengaku iseng',
      }, {});
      const params = sqlOf(client.query, 'UPDATE log_sos')![1];
      expect(params.slice(3, 5)).toEqual(['LAPORAN_TIDAK_VALID', true]);
    });

    it('rejects flagging an invalid report without closing the case', async () => {
      await expect(service.ubahStatus(psikolog, idSos, {
        status: 'DITANGANI', laporan_tidak_valid: true, catatan: 'x',
      }, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it("forbids updating another psychologist's case and conflicts on a finished one", async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE log_sos')) return { rows: [] };
        if (sql.includes('SELECT status_penanganan')) return { rows: [{ status_penanganan: 'DIAMBIL', id_psikolog: lain }] };
        return { rows: [] };
      });
      await expect(service.ubahStatus(psikolog, idSos, { status: 'SELESAI' }, {}))
        .rejects.toBeInstanceOf(ForbiddenException);

      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE log_sos')) return { rows: [] };
        if (sql.includes('SELECT status_penanganan')) {
          return { rows: [{ status_penanganan: 'SELESAI', id_psikolog: psikolog.id }] };
        }
        return { rows: [] };
      });
      await expect(service.ubahStatus(psikolog, idSos, { status: 'SELESAI' }, {}))
        .rejects.toBeInstanceOf(ConflictException);
      expect(notifikasi.sosDiperbarui).not.toHaveBeenCalled();
    });
  });

  describe('lokasiSos', () => {
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
      ['another psychologist', { id_psikolog: lain }],
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
});
