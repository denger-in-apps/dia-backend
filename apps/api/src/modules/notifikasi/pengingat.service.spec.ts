import { Pool, PoolClient } from 'pg';
import { EmailProvider } from './email/email.provider';
import { PengingatService } from './pengingat.service';

describe('PengingatService', () => {
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const item = {
    id_sesi: idSesi, offset_menit: 60, percobaan: 0, waktu_mulai: new Date('2026-12-01T02:00:00Z'), tipe_sesi: 'CHAT',
    id_mahasiswa: '11111111-1111-4111-8111-111111111111', id_psikolog: '22222222-2222-4222-8222-222222222222',
    email: 'budi.santoso@kampus.ac.id', nama_mahasiswa: 'Budi', nama_psikolog: 'Psikolog A', mahasiswa_dihapus: false,
  };
  let pool: { query: jest.Mock };
  let email: { kirim: jest.Mock };
  let klaim: unknown[];
  let service: PengingatService;

  beforeEach(() => {
    delete process.env.PENGINGAT_OFFSET_MENIT;
    klaim = [item];
    pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('WITH due AS')) return { rows: klaim };
        return { rows: [], rowCount: 1 };
      }),
    };
    email = { kirim: jest.fn().mockResolvedValue({ providerMessageId: 'm1' }) };
    service = new PengingatService(pool as unknown as Pool, email as unknown as EmailProvider);
  });

  const call = (fragment: string) => pool.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

  describe('jadwalkan', () => {
    it('replaces reminders with H-24h and H-1h offsets that are still in the future', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const waktu = new Date('2026-12-01T02:00:00Z');
      await service.jadwalkan(client as unknown as PoolClient, { id_sesi: idSesi, waktu_mulai: waktu, status_sesi: 'DIJADWALKAN' });
      expect(client.query.mock.calls[0]).toEqual(['DELETE FROM pengingat_sesi WHERE id_sesi = $1', [idSesi]]);
      const [sql, params] = client.query.mock.calls[1];
      expect(sql).toContain('make_interval(mins => o) > now()');
      expect(params).toEqual([idSesi, [1440, 60], waktu.toISOString()]);
    });

    it('only deletes reminders for cancelled sessions', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      await service.jadwalkan(client as unknown as PoolClient, { id_sesi: idSesi, waktu_mulai: new Date(), status_sesi: 'DIBATALKAN' });
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('honours and validates PENGINGAT_OFFSET_MENIT', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      process.env.PENGINGAT_OFFSET_MENIT = '30, 1440,30';
      await service.jadwalkan(client as unknown as PoolClient, { id_sesi: idSesi, waktu_mulai: new Date(), status_sesi: 'DIJADWALKAN' });
      expect(client.query.mock.calls[1][1][1]).toEqual([1440, 30]);
      process.env.PENGINGAT_OFFSET_MENIT = '2';
      await expect(service.jadwalkan(client as unknown as PoolClient, {
        id_sesi: idSesi, waktu_mulai: new Date(), status_sesi: 'DIJADWALKAN',
      })).rejects.toThrow('PENGINGAT_OFFSET_MENIT');
    });
  });

  describe('proses', () => {
    it('closes stale reminders, claims due rows with SKIP LOCKED and a lease', async () => {
      klaim = [];
      await service.proses();
      expect(call("error = 'SESI_TIDAK_RELEVAN'")).toHaveLength(1);
      const [sql, params] = call('WITH due AS')[0];
      expect(sql).toContain('FOR UPDATE OF pg SKIP LOCKED');
      expect(sql).toContain("s.status_sesi = 'DIJADWALKAN' AND s.waktu_mulai > now()");
      expect(params).toEqual([50, 300]);
    });

    it('creates the in-app notification exactly once for student and psychologist, then emails', async () => {
      const hasil = await service.proses();
      const [inAppSql, inAppParams] = call('INSERT INTO notifikasi')[0];
      expect(inAppSql).toContain('inapp_at IS NULL');
      expect(inAppSql).toContain("'PENGINGAT_SESI'");
      expect(inAppParams.slice(0, 4)).toEqual([idSesi, 60, item.id_mahasiswa, item.id_psikolog]);

      const kirim = email.kirim.mock.calls[0][0];
      expect(kirim.ke).toBe(item.email);
      expect(kirim.idempotencyKey).toBe(`pengingat:${idSesi}:60`);
      expect(kirim.teks).toContain('Psikolog A');
      expect(kirim.teks).toContain('chat');
      const selesai = call('dikirim_at = CASE')[0];
      expect(selesai[1]).toEqual([idSesi, 60, 'TERKIRIM', 1, null]);
      expect(hasil).toEqual({ diproses: 1, terkirim: 1, gagal: 0 });
    });

    it('retries failed emails with exponential backoff and masks the address in the stored error', async () => {
      email.kirim.mockRejectedValue(new Error('bounce budi.santoso@kampus.ac.id'));
      await service.proses();
      const [, params] = call('coba_lagi_at = now() + make_interval(secs => $5::int)')[0];
      expect(params).toEqual([idSesi, 60, 1, 'bounce bu***@kampus.ac.id', 60]);

      klaim = [{ ...item, percobaan: 1 }];
      await service.proses();
      expect(call('coba_lagi_at = now() + make_interval(secs => $5::int)')[1][1][4]).toBe(240);
    });

    it('marks the reminder GAGAL after the maximum attempts (use case alt 2.a)', async () => {
      email.kirim.mockRejectedValue(new Error('down'));
      klaim = [{ ...item, percobaan: 2 }];
      const hasil = await service.proses();
      expect(call('dikirim_at = CASE')[0][1]).toEqual([idSesi, 60, 'GAGAL', 3, 'down']);
      expect(hasil.gagal).toBe(1);
    });

    it('does not email deleted accounts', async () => {
      klaim = [{ ...item, mahasiswa_dihapus: true }];
      await service.proses();
      expect(email.kirim).not.toHaveBeenCalled();
      expect(call('dikirim_at = CASE')[0][1]).toEqual([idSesi, 60, 'GAGAL', 1, 'AKUN_DIHAPUS']);
    });

    it('keeps processing the batch when one reminder throws', async () => {
      klaim = [item, { ...item, offset_menit: 1440 }];
      let first = true;
      pool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('WITH due AS')) return { rows: klaim };
        if (sql.includes('INSERT INTO notifikasi') && first) {
          first = false;
          throw new Error('db hiccup');
        }
        return { rows: [], rowCount: 1 };
      });
      const hasil = await service.proses();
      expect(hasil).toEqual({ diproses: 2, terkirim: 1, gagal: 1 });
    });
  });
});
