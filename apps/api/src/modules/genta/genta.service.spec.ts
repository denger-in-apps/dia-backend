import { ConflictException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { GentaService } from './genta.service';
import { SosLokasiService } from './sos-lokasi.service';
import { SosKonfirmasiService } from './sos-konfirmasi.service';
import { tentukanPrioritas } from './genta.constants';

describe('tentukanPrioritas', () => {
  it('maps situations to priorities', () => {
    expect(tentukanPrioritas('INGIN_MENYAKITI_DIRI', false)).toBe('KRITIS');
    expect(tentukanPrioritas('DALAM_BAHAYA', false)).toBe('KRITIS');
    expect(tentukanPrioritas('SERANGAN_PANIK', false)).toBe('TINGGI');
    expect(tentukanPrioritas('LAINNYA', false)).toBe('SEDANG');
  });

  it('lowers priority one level for flagged accounts but never below TINGGI for critical situations', () => {
    expect(tentukanPrioritas('INGIN_MENYAKITI_DIRI', true)).toBe('TINGGI');
    expect(tentukanPrioritas('DALAM_BAHAYA', true)).toBe('TINGGI');
    expect(tentukanPrioritas('SERANGAN_PANIK', true)).toBe('SEDANG');
    expect(tentukanPrioritas('LAINNYA', true)).toBe('RENDAH');
  });
});

describe('GentaService', () => {
  const mhs = '11111111-1111-4111-8111-111111111111';
  const sosRow = {
    id_sos: '55555555-5555-4555-8555-555555555555', waktu_kejadian: new Date(), situasi: 'SERANGAN_PANIK',
    prioritas: 'TINGGI', status_penanganan: 'BARU', lokasi_izin: false, waktu_diambil: null, waktu_selesai: null,
  };
  const dto = { token_konfirmasi: 'token', situasi: 'SERANGAN_PANIK' as const, konfirmasi: true as const };
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let konfirmasi: { terbitkan: jest.Mock; verifikasi: jest.Mock; pakai: jest.Mock };
  let service: GentaService;
  let riwayat: { per_jam: number; iseng: number; batal: number };
  let aktif: unknown;
  let lokasi: SosLokasiService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    lokasi = new SosLokasiService(new EncryptionService());
  });

  beforeEach(() => {
    riwayat = { per_jam: 0, iseng: 0, batal: 0 };
    aktif = undefined;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id_sos::text') && sql.includes('status_penanganan IN')) {
          return { rows: aktif ? [aktif] : [] };
        }
        if (sql.includes('count(*) FILTER')) return { rows: [riwayat] };
        if (sql.includes('INSERT INTO log_sos')) {
          return { rows: [{ ...sosRow, id_sos: params![0], situasi: params![2], prioritas: params![3], lokasi_izin: params![5] }] };
        }
        if (sql.includes('SET lokasi_izin = true')) {
          return { rows: [{ ...(aktif as object), lokasi_izin: true }] };
        }
        return { rows: [] };
      }),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM konfigurasi_sos')) {
          return { rows: [{ hotline_label: 'Healing119.id — 119 ext. 8', hotline_aktif: true }] };
        }
        return { rows: [] };
      }),
    };
    konfirmasi = {
      terbitkan: jest.fn().mockResolvedValue({ token_konfirmasi: 't', berlaku_detik: 120 }),
      verifikasi: jest.fn().mockResolvedValue({ jti: 'jti-1' }),
      pakai: jest.fn().mockResolvedValue(true),
    };
    service = new GentaService(pool as unknown as Pool, konfirmasi as unknown as SosKonfirmasiService, lokasi);
  });

  const insertCall = () => client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO log_sos'));

  it('offers situation choices and the hotline together with the confirmation token', async () => {
    const result = await service.mintaKonfirmasi(mhs);
    expect(konfirmasi.terbitkan).toHaveBeenCalledWith(mhs);
    expect(result.situasi_opsi.map((o) => o.kode)).toContain('INGIN_MENYAKITI_DIRI');
    expect(result.hotline.label).toContain('119');
  });

  it('creates an SOS with server-side priority under a per-student lock', async () => {
    const result = await service.buatSos(mhs, dto);

    expect(result.baru).toBe(true);
    expect(konfirmasi.verifikasi).toHaveBeenCalledWith(mhs, 'token');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [`genta:${mhs}`]);
    expect(insertCall()![1].slice(1)).toEqual([mhs, 'SERANGAN_PANIK', 'TINGGI', false, false, null]);
    expect(konfirmasi.pakai).toHaveBeenCalledWith('jti-1');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('does not create an SOS when the confirmation is invalid', async () => {
    konfirmasi.verifikasi.mockRejectedValue(new UnprocessableEntityException({ kode: 'KONFIRMASI_TIDAK_VALID' }));
    await expect(service.buatSos(mhs, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('returns the existing active SOS instead of creating a duplicate', async () => {
    aktif = { ...sosRow, status_penanganan: 'DIAMBIL' };
    const result = await service.buatSos(mhs, dto);
    expect(result).toMatchObject({ baru: false, sos: { status_penanganan: 'DIAMBIL' } });
    expect(insertCall()).toBeUndefined();
    expect(konfirmasi.pakai).not.toHaveBeenCalled();
  });

  it('rejects a reused confirmation token', async () => {
    konfirmasi.pakai.mockResolvedValue(false);
    await expect(service.buatSos(mhs, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(insertCall()).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rate-limits new SOS per hour and still returns the hotline', async () => {
    riwayat.per_jam = 5;
    const error = await service.buatSos(mhs, dto).catch((e: HttpException) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      kode: 'SOS_TERLALU_SERING', detail: { hotline: { label: expect.stringContaining('119') } },
    });
    expect(insertCall()).toBeUndefined();
  });

  it.each([
    [{ iseng: 2, batal: 0 }],
    [{ iseng: 0, batal: 3 }],
  ])('accepts but flags SOS from accounts with abuse history %j', async (history) => {
    Object.assign(riwayat, history);
    const result = await service.buatSos(mhs, { ...dto, situasi: 'INGIN_MENYAKITI_DIRI' });
    expect(result.baru).toBe(true);
    expect(insertCall()![1].slice(1, 5)).toEqual([mhs, 'INGIN_MENYAKITI_DIRI', 'TINGGI', true]);
  });

  it('falls back to the existing SOS when the unique index rejects a concurrent insert', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*) FILTER')) return { rows: [riwayat] };
      if (sql.includes('INSERT INTO log_sos')) throw Object.assign(new Error('dup'), { code: '23505' });
      return { rows: [] };
    });
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM konfigurasi_sos')) return { rows: [] };
      if (sql.includes('FROM log_sos')) return { rows: [sosRow] };
      return { rows: [] };
    });
    const result = await service.buatSos(mhs, dto);
    expect(result).toMatchObject({ baru: false, sos: { id_sos: sosRow.id_sos } });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('cancels only an untaken SOS owned by the student', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...sosRow, status_penanganan: 'SELESAI' }] });
    await expect(service.batalkan(mhs, sosRow.id_sos)).resolves.toMatchObject({ status_penanganan: 'SELESAI' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id_sos = $1 AND id_mahasiswa = $2 AND status_penanganan = 'BARU'"),
      [sosRow.id_sos, mhs],
    );
  });

  it('explains why a cancellation is refused', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status_penanganan: 'DIAMBIL' }] });
    await expect(service.batalkan(mhs, sosRow.id_sos)).rejects.toBeInstanceOf(ConflictException);

    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(service.batalkan(mhs, sosRow.id_sos)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores a shared location encrypted and bound to the new SOS id', async () => {
    const result = await service.buatSos(mhs, { ...dto, lokasi: { lat: -6.2, lng: 106.8, akurasi_m: 15 } });

    const params = insertCall()![1];
    const [idSos, , , , , izin, ciphertext] = params;
    expect(result.sos.id_sos).toBe(idSos);
    expect(izin).toBe(true);
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.toString('utf8')).not.toContain('106.8');
    expect(lokasi.dekripsi(idSos, ciphertext)).toMatchObject({ lat: -6.2, lng: 106.8, akurasi_m: 15 });
    expect(() => lokasi.dekripsi('66666666-6666-4666-8666-666666666666', ciphertext)).toThrow();
  });

  it('attaches a location sent on retry to the existing active SOS', async () => {
    aktif = { ...sosRow };
    const result = await service.buatSos(mhs, { ...dto, lokasi: { lat: 1, lng: 2 } });
    expect(result).toMatchObject({ baru: false, sos: { lokasi_izin: true } });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET lokasi_izin = true'), [sosRow.id_sos, mhs, expect.any(Buffer)],
    );
    expect(insertCall()).toBeUndefined();
  });

  it('shares a location later only on an active SOS owned by the student', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...sosRow, lokasi_izin: true }] });
    await expect(service.bagikanLokasi(mhs, sosRow.id_sos, { lat: 1, lng: 2 }))
      .resolves.toMatchObject({ lokasi_izin: true });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE id_sos = $1 AND id_mahasiswa = $2 AND status_penanganan IN');
    expect(params.slice(0, 2)).toEqual([sosRow.id_sos, mhs]);

    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    await expect(service.bagikanLokasi(mhs, sosRow.id_sos, { lat: 1, lng: 2 }))
      .rejects.toBeInstanceOf(ConflictException);

    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(service.bagikanLokasi(mhs, sosRow.id_sos, { lat: 1, lng: 2 }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('withdraws location consent by deleting the coordinates', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...sosRow, lokasi_izin: false }] });
    await service.cabutLokasi(mhs, sosRow.id_sos);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('lokasi_izin = false, koordinat_lokasi_enc = NULL'), [sosRow.id_sos, mhs],
    );
  });

  it('deletes coordinates when the student cancels the SOS', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...sosRow, status_penanganan: 'SELESAI' }] });
    await service.batalkan(mhs, sosRow.id_sos);
    expect(pool.query.mock.calls[0][0]).toContain('koordinat_lokasi_enc = NULL');
  });
});
