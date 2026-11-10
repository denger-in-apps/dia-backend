import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { HasilKirimSms, maskNomor, SmsProvider } from './sms.provider';

/** Provider development: tidak mengirim SMS, hanya mencatat nomor tersamar (isi pesan tidak dicatat). */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('ConsoleSms');

  async kirim(nomor: string, teks: string, idempotencyKey: string): Promise<HasilKirimSms> {
    const id = `console-${randomUUID()}`;
    this.logger.log(`[SIMULASI] SMS ke ${maskNomor(nomor)} (${teks.length} karakter, key ${idempotencyKey}) → ${id}`);
    return { providerMessageId: id };
  }
}
