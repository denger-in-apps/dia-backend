import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { EskalasiTindakanService } from './eskalasi-tindakan.service';
import { SosTereskalasi } from './eskalasi.service';
import { KONFIGURASI_DEFAULT, KonfigurasiSos, KonfigurasiSosService } from './konfigurasi-sos.service';
import { SmsProvider } from './sms/sms.provider';

describe('EskalasiTindakanService', () => {
  const idSos = '55555555-5555-4555-8555-555555555555';
  const idMhs = '11111111-1111-4111-8111-111111111111';
  let encryption: EncryptionService;
  let pool: { query: jest.Mock };
  let sms: { kirim: jest.Mock };
  let config: KonfigurasiSos;
  let riwayatKontak: number;
  let service: EskalasiTindakanService;

  const sos = (overrides: Partial<SosTereskalasi> = {}): SosTereskalasi => ({
    id_sos: idSos, id_mahasiswa: idMhs, prioritas: 'TINGGI', situasi: 'SERANGAN_PANIK', lokasi_izin: false,
    perlu_verifikasi: false, waktu_kejadian: new Date(), waktu_eskalasi: new Date(), ...overrides,
  });

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    process.env.SMS_RETRY_BACKOFF_MS = '0';
    encryption = new EncryptionService();
  });

  afterAll(() => {
    delete process.env.SMS_RETRY_BACKOFF_MS;
  });

  beforeEach(() => {
    config = { ...KONFIGURASI_DEFAULT };
    riwayatKontak = 0;
    pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mahasiswa')) return { rows: [{ nama: 'Budi' }] };
        if (sql.includes('FROM penerima_eskalasi')) {
          return { rows: [{ id: 'pe1', no_telepon_enc: encryption.encrypt('081111111111', 'penerima_eskalasi:no_telepon_enc:pe1') }] };
        }
        if (sql.includes('FROM kontak_darurat')) {
          return { rows: [{ id: 'kd1', no_telepon_enc: encryption.encrypt('082222222222', 'kontak_darurat:no_telepon_enc:kd1') }] };
        }
        if (sql.includes('count(DISTINCT e.id_sos)')) return { rows: [{ jumlah: riwayatKontak }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    sms = { kirim: jest.fn().mockResolvedValue({ providerMessageId: 'msg-1' }) };
    service = new EskalasiTindakanService(
      pool as unknown as Pool,
      sms as unknown as SmsProvider,
      encryption,
      { ambil: jest.fn(async () => config) } as unknown as KonfigurasiSosService,
    );
  });

  const nomorTerkirim = () => sms.kirim.mock.calls.map(([nomor]) => nomor).sort();
  const logInserts = () => pool.query.mock.calls.filter(([sql]) => String(sql).includes("VALUES ($1, 'SMS'"));

  it('marks the 119 ext. 8 hotline escalation (phone line, not SMS) and logs it', async () => {
    const hasil = await service.jalankan(sos());
    expect(hasil.hotline).toBe(true);
    expect(pool.query).toHaveBeenCalledWith('UPDATE log_sos SET eskalasi_119 = true WHERE id_sos = $1', [idSos]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("'INFO_HOTLINE', 'HOTLINE'"), [idSos, 'Healing119.id — 119 ext. 8'],
    );
  });

  it('sends SMS to campus escalation recipients and emergency contacts with suitable texts', async () => {
    const hasil = await service.jalankan(sos());

    expect(hasil).toMatchObject({ sms_terkirim: 2, sms_gagal: 0, kontak_darurat_dilewati: null });
    expect(nomorTerkirim()).toEqual(['081111111111', '082222222222']);
    const [, teksKampus, keyKampus] = sms.kirim.mock.calls.find(([n]) => n === '081111111111')!;
    const [, teksKontak] = sms.kirim.mock.calls.find(([n]) => n === '082222222222')!;
    expect(teksKampus).toContain('SOS dari Budi belum direspons');
    expect(teksKontak).toContain('Mohon segera hubungi Budi');
    for (const teks of [teksKampus, teksKontak]) {
      expect(teks).toContain('119 ext. 8');
      expect(teks).not.toMatch(/panik|SERANGAN|lokasi|-?\d+\.\d+/i);
    }
    expect(keyKampus).toBe(`${idSos}:PENERIMA_ESKALASI:pe1`);
  });

  it('never writes full phone numbers to the escalation log', async () => {
    await service.jalankan(sos());
    for (const [, params] of logInserts()) {
      expect(params[2]).toMatch(/^\d{4}\*+\d{3}$/);
      expect(JSON.stringify(params)).not.toMatch(/081111111111|082222222222/);
    }
  });

  it('skips emergency contacts for a non-critical perlu_verifikasi SOS but still alerts campus', async () => {
    const hasil = await service.jalankan(sos({ perlu_verifikasi: true }));
    expect(hasil.kontak_darurat_dilewati).toBe('PERLU_VERIFIKASI');
    expect(nomorTerkirim()).toEqual(['081111111111']);
  });

  it.each(['INGIN_MENYAKITI_DIRI', 'DALAM_BAHAYA'])(
    'always alerts emergency contacts for critical situation %s, even when flagged',
    async (situasi) => {
      const hasil = await service.jalankan(sos({ perlu_verifikasi: true, situasi }));
      expect(hasil.kontak_darurat_dilewati).toBeNull();
      expect(nomorTerkirim()).toEqual(['081111111111', '082222222222']);
    },
  );

  it('caps emergency-contact escalations per student per day', async () => {
    riwayatKontak = 3;
    const hasil = await service.jalankan(sos({ situasi: 'INGIN_MENYAKITI_DIRI' }));
    expect(hasil.kontak_darurat_dilewati).toBe('BATAS_HARIAN');
    expect(nomorTerkirim()).toEqual(['081111111111']);
    const countQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes('count(DISTINCT e.id_sos)'))!;
    expect(countQuery[1]).toEqual([idMhs, idSos]);
  });

  it('respects admin settings for contacts and the hotline', async () => {
    config = { ...config, kontak_darurat_aktif: false, hotline_aktif: false };
    const hasil = await service.jalankan(sos());
    expect(hasil).toMatchObject({ hotline: false, kontak_darurat_dilewati: 'DINONAKTIFKAN_ADMIN' });
    expect(nomorTerkirim()).toEqual(['081111111111']);
    expect(sms.kirim.mock.calls[0][1]).not.toContain('119');

    sms.kirim.mockClear();
    config = { ...KONFIGURASI_DEFAULT, kontak_darurat_untuk_perlu_verifikasi: true };
    await service.jalankan(sos({ perlu_verifikasi: true }));
    expect(nomorTerkirim()).toEqual(['081111111111', '082222222222']);
  });

  it('retries a failing SMS up to 3 times with one log row per attempt', async () => {
    sms.kirim.mockImplementation(async (nomor: string) => {
      if (nomor === '082222222222' && sms.kirim.mock.calls.filter(([n]) => n === nomor).length < 3) {
        throw new Error('gateway 503 for 082222222222');
      }
      return { providerMessageId: 'ok' };
    });

    const hasil = await service.jalankan(sos());

    expect(hasil).toMatchObject({ sms_terkirim: 2, sms_gagal: 0 });
    const kontakLogs = logInserts().filter(([, params]) => params[1] === 'KONTAK_DARURAT');
    expect(kontakLogs.map(([, p]) => [p[3], p[5]])).toEqual([['GAGAL', 1], ['GAGAL', 2], ['TERKIRIM', 3]]);
    expect(kontakLogs[0][1][6]).toContain('0822*****222');
    expect(kontakLogs[0][1][6]).not.toContain('082222222222');
  });

  it('reports failures after 3 attempts without throwing', async () => {
    sms.kirim.mockRejectedValue(new Error('down'));
    const hasil = await service.jalankan(sos());
    expect(hasil).toMatchObject({ sms_terkirim: 0, sms_gagal: 2 });
    expect(sms.kirim).toHaveBeenCalledTimes(6);
  });

  it('never throws even when the database is unavailable', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await expect(service.jalankan(sos())).resolves.toMatchObject({ sms_terkirim: 0 });
  });
});
