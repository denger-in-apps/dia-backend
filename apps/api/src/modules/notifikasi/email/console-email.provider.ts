import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EmailKeluar, EmailProvider, maskEmail } from './email.provider';

/** Provider development: tidak mengirim email, hanya mencatat alamat tersamar (isi tidak dicatat). */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger('ConsoleEmail');

  async kirim(email: EmailKeluar): Promise<{ providerMessageId: string }> {
    const id = `console-${randomUUID()}`;
    this.logger.log(`[SIMULASI] Email ke ${maskEmail(email.ke)} "${email.subjek}" (key ${email.idempotencyKey}) → ${id}`);
    return { providerMessageId: id };
  }
}
