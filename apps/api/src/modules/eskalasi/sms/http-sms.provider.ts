import { Injectable } from '@nestjs/common';
import { HasilKirimSms, SmsProvider } from './sms.provider';

const TIMEOUT_MS = 5000;

/**
 * Adapter REST generik untuk SMS gateway terpilih. Kontrak sementara (sesuaikan dengan
 * dokumentasi resmi provider):
 *   POST SMS_GATEWAY_URL  Authorization: Bearer SMS_GATEWAY_TOKEN
 *   { "to": "...", "message": "...", "idempotency_key": "...", "sender": SMS_SENDER_ID? }
 *   → 2xx { "message_id"?: string }
 * Header `Idempotency-Key` juga dikirim untuk provider yang memakainya.
 */
@Injectable()
export class HttpSmsProvider implements SmsProvider {
  async kirim(nomor: string, teks: string, idempotencyKey: string): Promise<HasilKirimSms> {
    const endpoint = process.env.SMS_GATEWAY_URL?.trim();
    const token = process.env.SMS_GATEWAY_TOKEN?.trim();
    if (!endpoint || !token) throw new Error('SMS gateway belum dikonfigurasi');
    const url = new URL(endpoint);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('SMS gateway produksi wajib memakai HTTPS');
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
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          to: nomor,
          message: teks,
          idempotency_key: idempotencyKey,
          ...(process.env.SMS_SENDER_ID ? { sender: process.env.SMS_SENDER_ID } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`SMS gateway HTTP ${response.status}`);
      const payload = (await response.json().catch(() => ({}))) as { message_id?: unknown };
      return { providerMessageId: typeof payload.message_id === 'string' ? payload.message_id : null };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error(`SMS gateway timeout ${TIMEOUT_MS}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
