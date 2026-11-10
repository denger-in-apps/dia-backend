import { Pool } from 'pg';
import { PsikologGateway } from './psikolog.gateway';
import { SosBaruPayload, SosNotifikasiService } from './sos-notifikasi.service';

describe('SosNotifikasiService', () => {
  const sos: SosBaruPayload = {
    id_sos: '55555555-5555-4555-8555-555555555555',
    prioritas: 'KRITIS',
    situasi: 'INGIN_MENYAKITI_DIRI',
    situasi_label: 'Saya ingin menyakiti diri sendiri',
    waktu_kejadian: new Date().toISOString(),
    lokasi_tersedia: true,
    perlu_verifikasi: false,
  };
  let pool: { query: jest.Mock };
  let gateway: { kirimKePsikolog: jest.Mock; kirimKeSemuaPsikolog: jest.Mock };
  let service: SosNotifikasiService;
  let jaga: string[];
  let aktif: string[];

  beforeEach(() => {
    jaga = ['p-jaga'];
    aktif = ['p-jaga', 'p-lain'];
    pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM jadwal_jaga')) return { rows: jaga.map((id) => ({ id })) };
        if (sql.includes('FROM psikolog WHERE')) return { rows: aktif.map((id) => ({ id })) };
        return { rows: [], rowCount: 1 };
      }),
    };
    gateway = { kirimKePsikolog: jest.fn(), kirimKeSemuaPsikolog: jest.fn() };
    service = new SosNotifikasiService(pool as unknown as Pool, gateway as unknown as PsikologGateway);
    delete process.env.JADWAL_ZONA_WAKTU;
  });

  const insertCall = () => pool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notifikasi'));

  it('notifies the psychologists on duty now (WIB) and stores in-app notifications', async () => {
    const result = await service.sosBaru(sos);

    expect(result).toEqual({ penerima: 1, tanpa_jaga: false });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM jadwal_jaga'), ['Asia/Jakarta']);
    expect(gateway.kirimKePsikolog).toHaveBeenCalledWith(['p-jaga'], 'sos:baru', { ...sos, tanpa_jaga: false });
    const [sql, params] = insertCall()!;
    expect(sql).toContain("'SOS_BARU'");
    expect(params[0]).toEqual(['p-jaga']);
    expect(JSON.parse(params[1])).toMatchObject({ id_sos: sos.id_sos, prioritas: 'KRITIS' });
  });

  it('emits realtime before persisting so delivery is not delayed by the insert', async () => {
    await service.sosBaru(sos);
    const emitOrder = gateway.kirimKePsikolog.mock.invocationCallOrder[0];
    const insertIndex = pool.query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO notifikasi'));
    expect(emitOrder).toBeLessThan(pool.query.mock.invocationCallOrder[insertIndex]);
  });

  it('falls back to every active psychologist when nobody is on duty', async () => {
    jaga = [];
    const result = await service.sosBaru(sos);
    expect(result).toEqual({ penerima: 2, tanpa_jaga: true });
    expect(gateway.kirimKePsikolog).toHaveBeenCalledWith(
      ['p-jaga', 'p-lain'], 'sos:baru', expect.objectContaining({ tanpa_jaga: true }),
    );
  });

  it('never carries student identity in the payload', async () => {
    await service.sosBaru(sos);
    const payload = gateway.kirimKePsikolog.mock.calls[0][2];
    expect(Object.keys(payload)).not.toEqual(expect.arrayContaining(['id_mahasiswa']));
    expect(JSON.stringify(payload)).not.toMatch(/nim|email|nama/);
  });

  it('never throws, so a notification failure cannot break SOS creation', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await expect(service.sosBaru(sos)).resolves.toEqual({ penerima: 0, tanpa_jaga: false });
  });

  it('honours a configured duty time zone and rejects unsafe values', async () => {
    process.env.JADWAL_ZONA_WAKTU = 'Asia/Makassar';
    await service.sosBaru(sos);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM jadwal_jaga'), ['Asia/Makassar']);

    process.env.JADWAL_ZONA_WAKTU = "x'; DROP TABLE psikolog;--";
    gateway.kirimKePsikolog.mockClear();
    await expect(service.sosBaru(sos)).resolves.toEqual({ penerima: 0, tanpa_jaga: false });
    expect(gateway.kirimKePsikolog).not.toHaveBeenCalled();
  });

  it('broadcasts status updates to all connected psychologists', () => {
    service.sosDiperbarui({ id_sos: sos.id_sos, status_penanganan: 'DIAMBIL', id_psikolog: 'p-jaga' });
    expect(gateway.kirimKeSemuaPsikolog).toHaveBeenCalledWith('sos:diperbarui', expect.objectContaining({
      status_penanganan: 'DIAMBIL',
    }));
  });

  it('sends escalations to every active psychologist, not only those on duty, and stores them', async () => {
    const penerima = await service.sosEskalasi({
      id_sos: sos.id_sos, prioritas: 'KRITIS', situasi: sos.situasi, waktu_kejadian: sos.waktu_kejadian,
      waktu_eskalasi: new Date().toISOString(), lokasi_tersedia: true, perlu_verifikasi: false, sumber: 'TIMER',
    });
    expect(penerima).toBe(2);
    expect(gateway.kirimKePsikolog).toHaveBeenCalledWith(['p-jaga', 'p-lain'], 'sos:eskalasi', expect.objectContaining({
      id_sos: sos.id_sos, sumber: 'TIMER',
    }));
    expect(JSON.parse(insertCall()![1][1])).toMatchObject({ eskalasi: true });

    pool.query.mockRejectedValue(new Error('db down'));
    await expect(service.sosEskalasi({ id_sos: 'x' } as never)).resolves.toBe(0);
  });
});
