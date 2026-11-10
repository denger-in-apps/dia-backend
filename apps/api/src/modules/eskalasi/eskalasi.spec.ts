import { Job, Queue } from 'bullmq';
import { Pool } from 'pg';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { EskalasiProcessor } from './eskalasi.processor';
import { EskalasiSchedulerService } from './eskalasi-scheduler.service';
import { EskalasiService } from './eskalasi.service';
import { EskalasiTindakanService } from './eskalasi-tindakan.service';
import { EskalasiSweeper } from './eskalasi.sweeper';
import { KONFIGURASI_DEFAULT, KonfigurasiSosService } from './konfigurasi-sos.service';

const idSos = '55555555-5555-4555-8555-555555555555';

describe('EskalasiService', () => {
  let pool: { query: jest.Mock };
  let notifikasi: { sosDiperbarui: jest.Mock; sosEskalasi: jest.Mock };
  let tindakan: { jalankan: jest.Mock };
  let service: EskalasiService;

  beforeEach(() => {
    pool = { query: jest.fn() };
    notifikasi = { sosDiperbarui: jest.fn(), sosEskalasi: jest.fn().mockResolvedValue(3) };
    tindakan = { jalankan: jest.fn().mockResolvedValue({ hotline: true, sms_terkirim: 2, sms_gagal: 0, kontak_darurat_dilewati: null }) };
    service = new EskalasiService(
      pool as unknown as Pool, notifikasi as unknown as SosNotifikasiService,
      tindakan as unknown as EskalasiTindakanService,
    );
  });

  it('escalates only a still-unanswered SOS with a single conditional UPDATE', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id_sos: idSos, id_mahasiswa: 'm', prioritas: 'KRITIS', situasi: 'DALAM_BAHAYA', lokasi_izin: true,
        perlu_verifikasi: false, waktu_kejadian: new Date(), waktu_eskalasi: new Date(),
      }],
    });

    await expect(service.eskalasi(idSos, 'TIMER')).resolves.toBe(true);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("SET status_penanganan = 'ESKALASI', waktu_eskalasi = now()");
    expect(sql).toContain("WHERE id_sos = $1 AND status_penanganan = 'BARU'");
    expect(params).toEqual([idSos]);
    expect(notifikasi.sosDiperbarui).toHaveBeenCalledWith({ id_sos: idSos, status_penanganan: 'ESKALASI', id_psikolog: null });
    expect(notifikasi.sosEskalasi).toHaveBeenCalledWith(expect.objectContaining({
      id_sos: idSos, prioritas: 'KRITIS', sumber: 'TIMER',
    }));
    expect(JSON.stringify(notifikasi.sosEskalasi.mock.calls[0][0])).not.toContain('"id_mahasiswa"');
    expect(tindakan.jalankan).toHaveBeenCalledWith(expect.objectContaining({ id_sos: idSos, id_mahasiswa: 'm' }));
  });

  it('still escalates SOS flagged perlu_verifikasi (suspicion never blocks help)', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id_sos: idSos, perlu_verifikasi: true, waktu_kejadian: new Date(), waktu_eskalasi: new Date() }],
    });
    await expect(service.eskalasi(idSos, 'TIMER')).resolves.toBe(true);
    expect(notifikasi.sosEskalasi).toHaveBeenCalledWith(expect.objectContaining({ perlu_verifikasi: true }));
  });

  it('is a no-op once the case was taken, cancelled (salah tekan) or already escalated', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.eskalasi(idSos, 'SAPU')).resolves.toBe(false);
    expect(notifikasi.sosDiperbarui).not.toHaveBeenCalled();
    expect(notifikasi.sosEskalasi).not.toHaveBeenCalled();
    expect(tindakan.jalankan).not.toHaveBeenCalled();
  });
});

describe('EskalasiSchedulerService', () => {
  let queue: { add: jest.Mock; remove: jest.Mock; on: jest.Mock };
  let konfigurasi: { ambil: jest.Mock };
  let eskalasi: { eskalasi: jest.Mock };
  let service: EskalasiSchedulerService;

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue(1), on: jest.fn() };
    konfigurasi = { ambil: jest.fn().mockResolvedValue({ ...KONFIGURASI_DEFAULT }) };
    eskalasi = { eskalasi: jest.fn().mockResolvedValue(true) };
    service = new EskalasiSchedulerService(
      queue as unknown as Queue,
      konfigurasi as unknown as KonfigurasiSosService,
      eskalasi as unknown as EskalasiService,
    );
  });

  it('registers an error listener so Redis failures cannot crash the process', () => {
    service.onModuleInit();
    expect(queue.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('schedules a single delayed Redis job per SOS using the configured duration (default 3 minutes)', async () => {
    await expect(service.jadwalkan(idSos)).resolves.toEqual({ terjadwal: true, delay_ms: 180_000 });
    expect(queue.add).toHaveBeenCalledWith('eskalasi-sos', { id_sos: idSos }, expect.objectContaining({
      jobId: `eskalasi-${idSos}`, delay: 180_000, attempts: 5,
    }));

    konfigurasi.ambil.mockResolvedValue({ ...KONFIGURASI_DEFAULT, durasi_eskalasi_detik: 60 });
    await expect(service.jadwalkan(idSos)).resolves.toMatchObject({ delay_ms: 60_000 });
  });

  it('reports failure (sweeper takes over) when Redis rejects or hangs', async () => {
    queue.add.mockRejectedValueOnce(new Error('Stream isn\'t writeable'));
    await expect(service.jadwalkan(idSos)).resolves.toMatchObject({ terjadwal: false });

    jest.useFakeTimers();
    queue.add.mockReturnValueOnce(new Promise(() => undefined));
    const pending = service.jadwalkan(idSos);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ terjadwal: false });
    jest.useRealTimers();
  });

  it('escalates immediately when no psychologist exists at all', async () => {
    konfigurasi.ambil.mockResolvedValue({ ...KONFIGURASI_DEFAULT, eskalasi_segera_jika_tidak_ada_psikolog: false });
    await expect(service.tindakLanjutPenerima(idSos, 0, true)).resolves.toBe(true);
    expect(eskalasi.eskalasi).toHaveBeenCalledWith(idSos, 'TANPA_PSIKOLOG');
  });

  it('escalates immediately when nobody is on duty only if the admin enabled it', async () => {
    await expect(service.tindakLanjutPenerima(idSos, 4, true)).resolves.toBe(true);

    eskalasi.eskalasi.mockClear();
    konfigurasi.ambil.mockResolvedValue({ ...KONFIGURASI_DEFAULT, eskalasi_segera_jika_tidak_ada_psikolog: false });
    await expect(service.tindakLanjutPenerima(idSos, 4, true)).resolves.toBe(false);
    expect(eskalasi.eskalasi).not.toHaveBeenCalled();
  });

  it('does nothing extra when on-duty psychologists were notified', async () => {
    await expect(service.tindakLanjutPenerima(idSos, 2, false)).resolves.toBe(false);
    expect(konfigurasi.ambil).not.toHaveBeenCalled();
  });

  it('removes a timer without failing when Redis is down', async () => {
    queue.remove.mockRejectedValue(new Error('down'));
    await expect(service.batalkan(idSos)).resolves.toBeUndefined();
  });
});

describe('EskalasiSweeper', () => {
  it('escalates overdue BARU SOS from the database when the Redis timer is missing', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id_sos: 'a' }, { id_sos: 'b' }] }) };
    const eskalasi = { eskalasi: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const sweeper = new EskalasiSweeper(pool as unknown as Pool, eskalasi as unknown as EskalasiService);

    await expect(sweeper.sapu()).resolves.toBe(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("s.status_penanganan = 'BARU'");
    expect(sql).toContain('make_interval(secs => k.durasi + $1)');
    expect(params).toEqual([15]);
    expect(eskalasi.eskalasi).toHaveBeenNthCalledWith(1, 'a', 'SAPU');
    expect(eskalasi.eskalasi).toHaveBeenNthCalledWith(2, 'b', 'SAPU');
  });

  it('never throws and does not overlap runs', async () => {
    let release!: () => void;
    const pool = { query: jest.fn(() => new Promise((resolve) => { release = () => resolve({ rows: [] }); })) };
    const sweeper = new EskalasiSweeper(pool as unknown as Pool, { eskalasi: jest.fn() } as never);
    const first = sweeper.sapu();
    await expect(sweeper.sapu()).resolves.toBe(0);
    release();
    await first;
    expect(pool.query).toHaveBeenCalledTimes(1);

    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(sweeper.sapu()).resolves.toBe(0);
  });
});

describe('EskalasiProcessor', () => {
  it('runs the escalation for timer jobs', async () => {
    const eskalasi = { eskalasi: jest.fn().mockResolvedValue(true) };
    const processor = new EskalasiProcessor(eskalasi as unknown as EskalasiService);
    await expect(processor.process({ name: 'eskalasi-sos', data: { id_sos: idSos } } as Job))
      .resolves.toEqual({ dieskalasi: true });
    expect(eskalasi.eskalasi).toHaveBeenCalledWith(idSos, 'TIMER');
    await expect(processor.process({ name: 'lain', data: { id_sos: idSos } } as Job))
      .resolves.toEqual({ dieskalasi: false });
  });
});
