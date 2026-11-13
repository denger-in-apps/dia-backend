import { Injectable } from '@nestjs/common';
import { EmailKeluar, EmailProvider } from './email.provider';

const TIMEOUT_MS = 5000;

/**
 * Adapter REST generik untuk email gateway terpilih. Kontrak sementara (sesuaikan dengan
 * dokumentasi resmi provider):
 *   POST EMAIL_GATEWAY_URL  Authorization: Bearer EMAIL_GATEWAY_TOKEN  Idempotency-Key: <key>
 *   { "from": EMAIL_PENGIRIM, "to": "...", "subject": "...", "text": "..." }
 *   → 2xx { "message_id"?: string }
 */
@Injectable()
export class HttpEmailProvider implements EmailProvider {
  async kirim(email: EmailKeluar): Promise<{ providerMessageId: string | null }> {
    const endpoint = process.env.EMAIL_GATEWAY_URL?.trim();
    const token = process.env.EMAIL_GATEWAY_TOKEN?.trim();
    const pengirim = process.env.EMAIL_PENGIRIM?.trim();
    if (!endpoint || !token || !pengirim) throw new Error('Email gateway belum dikonfigurasi');
    const url = new URL(endpoint);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('Email gateway produksi wajib memakai HTTPS');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({ from: pengirim, to: email.ke, subject: email.subjek, text: email.teks }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Email gateway HTTP ${response.status}`);
      const payload = (await response.json().catch(() => ({}))) as { message_id?: unknown };
      return { providerMessageId: typeof payload.message_id === 'string' ? payload.message_id : null };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error(`Email gateway timeout ${TIMEOUT_MS}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
