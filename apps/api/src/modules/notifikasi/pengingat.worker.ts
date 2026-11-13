import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PengingatService } from './pengingat.service';

/** Menjalankan pengiriman pengingat sesi setiap menit (aman di semua instance karena klaim SKIP LOCKED). */
@Injectable()
export class PengingatWorker {
  private readonly logger = new Logger(PengingatWorker.name);
  private berjalan = false;

  constructor(private readonly pengingat: PengingatService) {}

  @Interval('pengingat-sesi', 60_000)
  async jalankan(): Promise<void> {
    if (this.berjalan) return;
    this.berjalan = true;
    try {
      const hasil = await this.pengingat.proses();
      if (hasil.diproses > 0) {
        this.logger.log(`Pengingat sesi: ${hasil.diproses} diproses, ${hasil.terkirim} email terkirim, ${hasil.gagal} gagal`);
      }
    } catch (error) {
      this.logger.error(`Worker pengingat sesi gagal: ${(error as Error).message}`);
    } finally {
      this.berjalan = false;
    }
  }
}
