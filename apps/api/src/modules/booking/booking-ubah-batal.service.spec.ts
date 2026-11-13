import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PsikologGateway } from '../realtime/psikolog.gateway';
import { PengingatService } from '../notifikasi/pengingat.service';
import { SesiGateway } from '../sesi/sesi.gateway';
import { BookingService } from './booking.service';

/** PBI-12: ubah jadwal & batal sesi. */
describe('BookingService ubah jadwal & batal', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  const idPsi = '22222222-2222-4222-8222-222222222222';
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const jam = 3_600_000;
  const waktuBaru = '2026-12-02T10:00:00+07:00';

  let row: Record<string, unknown>;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let gateway: { kirimKePsikolog: jest.Mock };
  let ruangSesi: { siarkanStatus: jest.Mock };
  let pengingat: { jadwalkan: jest.Mock };
  let slotSah: unknown[];
  let service: BookingService;

  beforeEach(() => {
    row = {
      id_sesi: idSesi, waktu_mulai: new Date(Date.now() + 48 * jam), waktu_selesai: new Date(Date.now() + 49 * jam),
      tipe_sesi: 'CHAT', status_sesi: 'DIJADWALKAN', consent_catatan: false, alasan_batal: null, created_at: new Date(),
      keluhan_awal_enc: null, id_psikolog: idPsi, nama_psikolog: 'Psikolog A',
    };
    slotSah = [{ id_psikolog: idPsi }];
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM sesi_konseling s JOIN psikolog')) return { rows: [row] };
        if (sql.startsWith('UPDATE sesi_konseling SET status_sesi')) {
          row = { ...row, status_sesi: 'DIBATALKAN' };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM sesi_konseling s JOIN psikolog')) return { rows: [row] };
        if (sql.includes('generate_series')) return { rows: params[8] === false ? slotSah : [{ id_psikolog: idPsi }] };
        return { rows: [] };
      }),
    };
    gateway = { kirimKePsikolog: jest.fn() };
    ruangSesi = { siarkanStatus: jest.fn() };
    pengingat = { jadwalkan: jest.fn() };
    service = new BookingService(
      pool as unknown as Pool,
      { encrypt: jest.fn(), decrypt: jest.fn() } as unknown as EncryptionService,
      gateway as unknown as PsikologGateway,
      ruangSesi as unknown as SesiGateway,
      pengingat as unknown as PengingatService,
    );
  });

  const clientCall = (fragment: string) => client.query.mock.calls.find(([sql]) => String(sql).includes(fragment));

  describe('ubahJadwal', () => {
    it('moves the session to a valid slot under a row lock and notifies the psychologist with the old time', async () => {
      const lama = (row.waktu_mulai as Date).toISOString();
      await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru, tipe_sesi: 'SUARA' });

      expect(clientCall('FOR UPDATE OF s')).toBeDefined();
      expect(clientCall('SET waktu_mulai')![1]).toEqual([idSesi, '2026-12-02T03:00:00.000Z', 50, 'SUARA']);
      const notif = clientCall('INSERT INTO notifikasi')!;
      expect(notif[1][1]).toBe('SESI_DIUBAH');
      expect(JSON.parse(notif[1][2]).waktu_mulai_lama).toBe(lama);
      expect(gateway.kirimKePsikolog).toHaveBeenCalledWith(
        [idPsi], 'booking:diubah', expect.objectContaining({ waktu_mulai_lama: lama }));
      expect(pengingat.jadwalkan).toHaveBeenCalledWith(client, expect.objectContaining({ id_sesi: idSesi }));
    });

    it('is a no-op when nothing changes', async () => {
      const sama = (row.waktu_mulai as Date).toISOString();
      await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: sama });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rejects invalid slots', async () => {
      slotSah = [];
      const error = await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru }).catch((e) => e);
      expect(error.getResponse().kode).toBe('SLOT_TIDAK_VALID');
    });

    it('rejects changes too close to the session or for non-scheduled sessions', async () => {
      row.waktu_mulai = new Date(Date.now() + 30 * 60_000);
      let error = await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru }).catch((e) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().kode).toBe('BATAS_WAKTU_TERLEWATI');

      row.waktu_mulai = new Date(Date.now() + 48 * jam);
      row.status_sesi = 'SELESAI';
      error = await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru }).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().kode).toBe('SESI_TIDAK_DAPAT_DIUBAH');
    });

    it('re-checks the status inside the transaction (cancelled concurrently)', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM sesi_konseling s JOIN psikolog')) return { rows: [{ ...row, status_sesi: 'DIBATALKAN' }] };
        return { rows: [] };
      });
      const error = await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru }).catch((e) => e);
      expect(error.getResponse().kode).toBe('SESI_SUDAH_DIBATALKAN');
      expect(clientCall('SET waktu_mulai')).toBeUndefined();
    });

    it('maps slot conflicts to 409 with alternatives that ignore the session being moved', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM sesi_konseling s JOIN psikolog')) return { rows: [row] };
        if (sql.includes('SET waktu_mulai')) {
          throw Object.assign(new Error('x'), { code: '23P01', constraint: 'sesi_tidak_bentrok_psikolog' });
        }
        return { rows: [] };
      });
      const error = await service.ubahJadwal(idMhs, idSesi, { waktu_mulai: waktuBaru }).catch((e) => e);
      expect(error.getResponse().kode).toBe('SESI_BENTROK');
      const altCall = pool.query.mock.calls.filter(([sql, p]) => String(sql).includes('generate_series') && p[8] === true)[0];
      expect(altCall[1][10]).toBe(idSesi);
    });
  });

  describe('batal', () => {
    it('cancels a scheduled session with a reason, notifies without the reason and closes the room', async () => {
      const hasil = await service.batal(idMhs, idSesi, { alasan: 'Ada ujian susulan' });
      expect(clientCall("SET status_sesi = 'DIBATALKAN'")![1]).toEqual([idSesi, 'Ada ujian susulan']);
      const notif = clientCall('INSERT INTO notifikasi')!;
      expect(notif[1][1]).toBe('SESI_DIBATALKAN');
      expect(notif[1][2]).not.toContain('ujian');
      expect(gateway.kirimKePsikolog).toHaveBeenCalledWith([idPsi], 'booking:dibatalkan', expect.any(Object));
      expect(ruangSesi.siarkanStatus).toHaveBeenCalledWith(idSesi, { id_sesi: idSesi, status_sesi: 'DIBATALKAN' });
      expect(hasil.status_sesi).toBe('DIBATALKAN');
      expect(pengingat.jadwalkan).toHaveBeenCalledWith(client, expect.objectContaining({ status_sesi: 'DIBATALKAN' }));
    });

    it('uses a default reason', async () => {
      await service.batal(idMhs, idSesi, {});
      expect(clientCall("SET status_sesi = 'DIBATALKAN'")![1]).toEqual([idSesi, 'Dibatalkan mahasiswa']);
    });

    it('allows late cancellation until the session starts, but not afterwards', async () => {
      row.waktu_mulai = new Date(Date.now() + 5 * 60_000);
      await expect(service.batal(idMhs, idSesi, {})).resolves.toBeDefined();

      row = { ...row, status_sesi: 'DIJADWALKAN', waktu_mulai: new Date(Date.now() - 60_000) };
      const error = await service.batal(idMhs, idSesi, {}).catch((e) => e);
      expect(error.getResponse().kode).toBe('BATAS_WAKTU_TERLEWATI');
    });

    it('rejects cancelling twice', async () => {
      row.status_sesi = 'DIBATALKAN';
      const error = await service.batal(idMhs, idSesi, {}).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().kode).toBe('SESI_SUDAH_DIBATALKAN');
      expect(gateway.kirimKePsikolog).not.toHaveBeenCalled();
    });
  });
});
