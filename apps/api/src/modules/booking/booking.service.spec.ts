import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PsikologGateway } from '../realtime/psikolog.gateway';
import { BookingService } from './booking.service';

describe('BookingService', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const dto = {
    id_psikolog: idPsi,
    waktu_mulai: '2026-12-01T09:00:00+07:00',
    tipe_sesi: 'CHAT' as const,
    keluhan_awal: 'Sulit tidur menjelang ujian',
  };
  const sesiRow = {
    id_sesi: idSesi, waktu_mulai: new Date('2026-12-01T02:00:00Z'), waktu_selesai: new Date('2026-12-01T02:50:00Z'),
    tipe_sesi: 'CHAT', status_sesi: 'DIJADWALKAN', consent_catatan: false, alasan_batal: null,
    created_at: new Date(), keluhan_awal_enc: Buffer.from('enc'), id_psikolog: idPsi, nama_psikolog: 'Psikolog A',
  };

  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let gateway: { kirimKePsikolog: jest.Mock };
  let slotSahResult: unknown[];
  let alternatifRows: unknown[];
  let jumlahAktif: number;
  let service: BookingService;

  beforeEach(() => {
    slotSahResult = [{ id_psikolog: idPsi }];
    alternatifRows = [{ id_psikolog: idPsi, waktu_mulai: new Date('2026-12-01T03:00:00Z') }];
    jumlahAktif = 0;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mahasiswa WHERE id_mahasiswa')) return { rows: [{}], rowCount: 1 };
        if (sql.includes('count(*)::int AS jumlah')) return { rows: [{ jumlah: jumlahAktif }] };
        if (sql.includes('INSERT INTO sesi_konseling')) return { rows: [{ id_sesi: idSesi }] };
        if (sql.includes('FROM sesi_konseling s JOIN psikolog')) return { rows: [sesiRow] };
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM psikolog WHERE id_psikolog')) return { rows: [{}], rowCount: 1 };
        if (sql.includes('generate_series')) return { rows: params[8] === false ? slotSahResult : alternatifRows };
        return { rows: [] };
      }),
    };
    encryption = {
      encrypt: jest.fn(() => Buffer.from('enc')),
      decrypt: jest.fn(() => Buffer.from('Sulit tidur menjelang ujian')),
    };
    gateway = { kirimKePsikolog: jest.fn() };
    service = new BookingService(
      pool as unknown as Pool,
      encryption as unknown as EncryptionService,
      gateway as unknown as PsikologGateway,
    );
  });

  const clientCall = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  it('books a valid slot, encrypts the complaint bound to the session row, and notifies the psychologist', async () => {
    const hasil = await service.buat(idMhs, dto);

    const insert = clientCall('INSERT INTO sesi_konseling')!;
    expect(insert[1]).toEqual([
      expect.any(String), '2026-12-01T02:00:00.000Z', 50, 'CHAT', Buffer.from('enc'), idMhs, idPsi,
    ]);
    const idBaru = insert[1][0];
    expect(encryption.encrypt).toHaveBeenCalledWith(dto.keluhan_awal, `sesi_konseling:keluhan_awal_enc:${idBaru}`);
    expect(clientCall('FOR UPDATE')).toBeDefined();
    const notif = clientCall('INSERT INTO notifikasi')!;
    expect(notif[1][1]).toBe('SESI_BARU');
    expect(notif[1][2]).not.toContain('Sulit tidur');
    expect(gateway.kirimKePsikolog).toHaveBeenCalledWith([idPsi], 'booking:baru', expect.objectContaining({ id_sesi: idSesi }));
    expect(hasil).toEqual(expect.objectContaining({
      id_sesi: idSesi, keluhan_awal: dto.keluhan_awal, psikolog: { id: idPsi, nama: 'Psikolog A' },
    }));
    expect(hasil).not.toHaveProperty('keluhan_awal_enc');
  });

  it('rejects a time that is not one of the psychologist slots without touching the DB transaction', async () => {
    slotSahResult = [];
    const error = await service.buat(idMhs, dto).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse().kode).toBe('SLOT_TIDAK_VALID');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects inactive or unknown psychologists', async () => {
    pool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await expect(service.buat(idMhs, dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('limits the number of upcoming sessions per student', async () => {
    jumlahAktif = 3;
    const error = await service.buat(idMhs, dto).catch((e) => e);
    expect(error.getResponse().kode).toBe('BATAS_SESI_AKTIF');
    expect(clientCall('INSERT INTO sesi_konseling')).toBeUndefined();
    expect(clientCall('ROLLBACK')).toBeDefined();
  });

  it('maps the psychologist exclusion violation to 409 SESI_BENTROK with alternative slots', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa WHERE id_mahasiswa')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('count(*)::int AS jumlah')) return { rows: [{ jumlah: 0 }] };
      if (sql.includes('INSERT INTO sesi_konseling')) {
        throw Object.assign(new Error('conflict'), { code: '23P01', constraint: 'sesi_tidak_bentrok_psikolog' });
      }
      return { rows: [] };
    });
    const error = await service.buat(idMhs, dto).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual(expect.objectContaining({
      kode: 'SESI_BENTROK', detail: { alternatif: alternatifRows },
    }));
    expect(gateway.kirimKePsikolog).not.toHaveBeenCalled();
  });

  it('falls back to other psychologists around the requested time when the same psychologist is full', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa WHERE id_mahasiswa')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('count(*)::int AS jumlah')) return { rows: [{ jumlah: 0 }] };
      if (sql.includes('INSERT INTO sesi_konseling')) {
        throw Object.assign(new Error('conflict'), { code: '23P01', constraint: 'sesi_tidak_bentrok_psikolog' });
      }
      return { rows: [] };
    });
    const lain = [{ id_psikolog: 'lain', waktu_mulai: new Date() }];
    pool.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM psikolog WHERE id_psikolog')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('generate_series')) {
        if (params[8] === false) return { rows: slotSahResult };
        return { rows: params[0] === idPsi ? [] : lain };
      }
      return { rows: [] };
    });
    const error = await service.buat(idMhs, dto).catch((e) => e);
    expect(error.getResponse().detail.alternatif).toEqual(lain);
    const lainCall = pool.query.mock.calls.filter(([sql]) => String(sql).includes('generate_series')).pop()!;
    expect(lainCall[1][0]).toBeNull();
  });

  it('maps the student exclusion violation to 409 SESI_BENTROK_MAHASISWA', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa WHERE id_mahasiswa')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('count(*)::int AS jumlah')) return { rows: [{ jumlah: 0 }] };
      if (sql.includes('INSERT INTO sesi_konseling')) {
        throw Object.assign(new Error('conflict'), { code: '23P01', constraint: 'sesi_tidak_bentrok_mahasiswa' });
      }
      return { rows: [] };
    });
    const error = await service.buat(idMhs, dto).catch((e) => e);
    expect(error.getResponse().kode).toBe('SESI_BENTROK_MAHASISWA');
  });

  it('scopes listing and detail to the student and only decrypts the complaint in detail', async () => {
    pool.query.mockResolvedValue({ rows: [sesiRow] });
    const daftar = await service.daftar(idMhs, { cakupan: 'riwayat' });
    expect(daftar[0].keluhan_awal).toBeNull();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('s.id_mahasiswa = $1');
    expect(sql).toContain(`('SELESAI', 'DIBATALKAN', 'TIDAK_HADIR')`);
    expect(params).toEqual([idMhs, 50]);
    expect(encryption.decrypt).not.toHaveBeenCalled();

    const detail = await service.detail(idMhs, idSesi);
    expect(detail.keluhan_awal).toBe('Sulit tidur menjelang ujian');
    expect(encryption.decrypt).toHaveBeenCalledWith(Buffer.from('enc'), `sesi_konseling:keluhan_awal_enc:${idSesi}`);
  });

  it('returns 404 for sessions of other students', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.detail(idMhs, idSesi)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists slots for a valid local date only', async () => {
    await service.slot(idMhs, idPsi, '2026-12-01');
    const call = pool.query.mock.calls.find(([sql]) => String(sql).includes('generate_series'))!;
    expect(call[1][0]).toBe(idPsi);
    expect(call[1][9]).toBe(idMhs);
    expect(call[1][11]).toBe('2026-12-01');
    await expect(service.slot(idMhs, idPsi, '2026-02-30')).rejects.toThrow();
  });
});
