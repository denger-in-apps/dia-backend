import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ESKALASI_QUEUE, JOB_ESKALASI_SOS, jobIdEskalasi } from './eskalasi.constants';
import { EskalasiService } from './eskalasi.service';
import { KonfigurasiSosService } from './konfigurasi-sos.service';
import { LogThrottle } from './log-throttle';

const REDIS_TIMEOUT_MS = 2000;

function denganBatasWaktu<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface HasilJadwal {
  terjadwal: boolean;
  delay_ms: number;
}

/**
 * Timer eskalasi SOS di Redis (BullMQ delayed job) — tahan restart API dan aman di
 * multi-instance (jobId deterministik per SOS). Bila Redis tidak dapat dijangkau, SOS
 * tetap aman: `EskalasiSweeper` memeriksa DB secara berkala dan mengambil alih.
 */
@Injectable()
export class EskalasiSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(EskalasiSchedulerService.name);
  private readonly throttled = new LogThrottle(this.logger);

  constructor(
    @InjectQueue(ESKALASI_QUEUE) private readonly queue: Queue,
    private readonly konfigurasi: KonfigurasiSosService,
    private readonly eskalasi: EskalasiService,
  ) {}

  onModuleInit(): void {
    // Tanpa listener, event 'error' dari koneksi Redis dapat menjatuhkan proses.
    this.queue.on('error', (error) => this.throttled.warn(`Queue eskalasi: ${error.message}`));
  }

  /** Jadwalkan eskalasi setelah `durasi_eskalasi_detik` (default 180 dtk) bila SOS belum diambil. */
  async jadwalkan(idSos: string): Promise<HasilJadwal> {
    const { durasi_eskalasi_detik } = await this.konfigurasi.ambil();
    const delay = durasi_eskalasi_detik * 1000;
    try {
      await denganBatasWaktu(
        this.queue.add(JOB_ESKALASI_SOS, { id_sos: idSos }, {
          jobId: jobIdEskalasi(idSos),
          delay,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        }),
        REDIS_TIMEOUT_MS,
      );
      return { terjadwal: true, delay_ms: delay };
    } catch (error) {
      this.logger.error(
        `Timer eskalasi SOS ${idSos} gagal dijadwalkan di Redis (${(error as Error).message}); sweeper DB mengambil alih`,
      );
      return { terjadwal: false, delay_ms: delay };
    }
  }

  /**
   * Dipanggil setelah notifikasi SOS terkirim. Tidak ada psikolog sama sekali → eskalasi
   * seketika; tidak ada yang jaga → seketika bila dikonfigurasi admin.
   */
  async tindakLanjutPenerima(idSos: string, penerima: number, tanpaJaga: boolean): Promise<boolean> {
    if (penerima > 0 && !tanpaJaga) return false;
    const { eskalasi_segera_jika_tidak_ada_psikolog } = await this.konfigurasi.ambil();
    if (penerima > 0 && !eskalasi_segera_jika_tidak_ada_psikolog) return false;
    return this.eskalasi.eskalasi(idSos, 'TANPA_PSIKOLOG');
  }

  /** Hapus timer (mis. kasus sudah diambil). Opsional: eskalasi tetap no-op karena UPDATE bersyarat. */
  async batalkan(idSos: string): Promise<void> {
    try {
      await denganBatasWaktu(this.queue.remove(jobIdEskalasi(idSos)), REDIS_TIMEOUT_MS);
    } catch {
      // Timer yang tersisa akan berakhir no-op.
    }
  }
}
