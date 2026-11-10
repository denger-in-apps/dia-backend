import { ConsoleSmsProvider } from './console-sms.provider';
import { HttpSmsProvider } from './http-sms.provider';
import { maskNomor } from './sms.provider';

describe('maskNomor', () => {
  it('keeps only the first 4 and last 3 digits', () => {
    expect(maskNomor('081234567890')).toBe('0812*****890');
    expect(maskNomor('+6281234567890')).toBe('+628*******890');
    expect(maskNomor('12345')).toBe('*****');
  });
});

describe('ConsoleSmsProvider', () => {
  it('simulates delivery without sending', async () => {
    const result = await new ConsoleSmsProvider().kirim('081234567890', 'halo', 'k');
    expect(result.providerMessageId).toMatch(/^console-/);
  });
});

describe('HttpSmsProvider', () => {
  const provider = new HttpSmsProvider();
  let fetchMock: jest.SpyInstance;
  const env = { ...process.env };

  beforeEach(() => {
    process.env.SMS_GATEWAY_URL = 'https://sms.example/api/send';
    process.env.SMS_GATEWAY_TOKEN = 'secret-token';
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    process.env = { ...env };
  });

  it('posts the message with bearer auth and an idempotency key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message_id: 'abc' }), { status: 200 }));

    await expect(provider.kirim('081234567890', 'teks', 'sos:KONTAK:1')).resolves.toEqual({ providerMessageId: 'abc' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sms.example/api/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-token', 'idempotency-key': 'sos:KONTAK:1' });
    expect(JSON.parse(init.body)).toEqual({ to: '081234567890', message: 'teks', idempotency_key: 'sos:KONTAK:1' });
  });

  it('fails on non-2xx responses and missing configuration', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }));
    await expect(provider.kirim('0812', 't', 'k')).rejects.toThrow('SMS gateway HTTP 502');

    delete process.env.SMS_GATEWAY_TOKEN;
    await expect(provider.kirim('0812', 't', 'k')).rejects.toThrow('belum dikonfigurasi');
  });

  it('requires HTTPS in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_GATEWAY_URL = 'http://sms.example/api/send';
    await expect(provider.kirim('0812', 't', 'k')).rejects.toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
