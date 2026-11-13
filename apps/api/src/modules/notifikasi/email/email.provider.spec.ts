import { maskEmail } from './email.provider';
import { HttpEmailProvider } from './http-email.provider';

describe('Email providers', () => {
  const env = { ...process.env };
  const email = { ke: 'budi@kampus.ac.id', subjek: 'Pengingat', teks: 'Halo', idempotencyKey: 'pengingat:s:60' };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.EMAIL_GATEWAY_URL = 'https://mail.example/send';
    process.env.EMAIL_GATEWAY_TOKEN = 'rahasia';
    process.env.EMAIL_PENGIRIM = 'noreply@denger.local';
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm1' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('masks addresses for logs', () => {
    expect(maskEmail('budi.santoso@kampus.ac.id')).toBe('bu***@kampus.ac.id');
    expect(maskEmail('tanpa-at')).toBe('***');
  });

  it('posts JSON with bearer token and idempotency key', async () => {
    const hasil = await new HttpEmailProvider().kirim(email);
    expect(hasil).toEqual({ providerMessageId: 'm1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://mail.example/send');
    expect(init.headers).toEqual(expect.objectContaining({ authorization: 'Bearer rahasia', 'idempotency-key': 'pengingat:s:60' }));
    expect(JSON.parse(init.body)).toEqual({ from: 'noreply@denger.local', to: email.ke, subject: 'Pengingat', text: 'Halo' });
  });

  it('fails when unconfigured, on non-2xx, and on HTTP in production', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(new HttpEmailProvider().kirim(email)).rejects.toThrow('HTTP 503');

    delete process.env.EMAIL_PENGIRIM;
    await expect(new HttpEmailProvider().kirim(email)).rejects.toThrow('belum dikonfigurasi');

    process.env.EMAIL_PENGIRIM = 'noreply@denger.local';
    process.env.EMAIL_GATEWAY_URL = 'http://mail.example/send';
    process.env.NODE_ENV = 'production';
    await expect(new HttpEmailProvider().kirim(email)).rejects.toThrow('HTTPS');
  });
});
