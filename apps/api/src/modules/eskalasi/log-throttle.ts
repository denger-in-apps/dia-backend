import { Logger } from '@nestjs/common';

/**
 * Mencatat peringatan berulang (mis. Redis tidak terjangkau dan terus dicoba ulang)
 * paling sering sekali per `jedaMs` untuk pesan yang sama, agar log tidak banjir.
 */
export class LogThrottle {
  private readonly terakhir = new Map<string, number>();

  constructor(private readonly logger: Logger, private readonly jedaMs = 60_000) {}

  warn(pesan: string): void {
    const now = Date.now();
    const sebelumnya = this.terakhir.get(pesan);
    if (sebelumnya !== undefined && now - sebelumnya < this.jedaMs) return;
    this.terakhir.set(pesan, now);
    if (this.terakhir.size > 100) this.terakhir.delete(this.terakhir.keys().next().value as string);
    this.logger.warn(pesan);
  }
}
