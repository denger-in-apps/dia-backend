import * as http from 'http';
import { AddressInfo } from 'net';
import { ServiceUnavailableException } from '@nestjs/common';
import { HttpAkademikClient } from './http-akademik.client';
import { MockAkademikClient } from './mock-akademik.client';
import { AkademikModule } from './akademik.module';
import { AKADEMIK_CLIENT } from './akademik.types';

const ENV_KEYS = ['AKADEMIK_STATUS_URL', 'AKADEMIK_API_TOKEN', 'AKADEMIK_MOCK_ACTIVE_NIMS', 'AKADEMIK_MODE', 'NODE_ENV'];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('HttpAkademikClient (server HTTP lokal sungguhan)', () => {
  let server: http.Server;
  let base: string;
  let last: { auth?: string; nim?: string | null };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      last = { auth: req.headers.authorization, nim: url.searchParams.get('nim') };
      if (url.pathname === '/lambat') { setTimeout(() => res.end('{"aktif":true}'), 5000).unref(); return; }
      if (url.pathname === '/rusak') { res.end('{"status":"aktif"}'); return; }
      if (url.pathname === '/error') { res.statusCode = 500; res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ aktif: url.searchParams.get('nim') === '1302210001' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  beforeEach(() => { process.env.AKADEMIK_API_TOKEN = 'token-uji'; });
  const client = new HttpAkademikClient();

  it('mengirim NIM sebagai query dan Bearer token, lalu membaca {aktif}', async () => {
    process.env.AKADEMIK_STATUS_URL = `${base}/status`;
    await expect(client.cekStatus('1302210001')).resolves.toBe(true);
    expect(last).toEqual({ auth: 'Bearer token-uji', nim: '1302210001' });
    await expect(client.cekStatus('1302210099')).resolves.toBe(false);
  });

  it('memutus permintaan setelah 3 detik', async () => {
    process.env.AKADEMIK_STATUS_URL = `${base}/lambat`;
    const started = Date.now();
    await expect(client.cekStatus('1302210001')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);

  it.each([
    ['payload tanpa boolean aktif', '/rusak'],
    ['HTTP 500', '/error'],
  ])('menganggap %s sebagai gangguan (503)', async (_label, path) => {
    process.env.AKADEMIK_STATUS_URL = `${base}${path}`;
    await expect(client.cekStatus('1302210001')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('menolak bila URL atau token belum dikonfigurasi', async () => {
    process.env.AKADEMIK_STATUS_URL = '';
    await expect(client.cekStatus('1302210001')).rejects.toThrow('Integrasi akademik belum dikonfigurasi');
  });

  it('menolak URL non-HTTPS di production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AKADEMIK_STATUS_URL = `${base}/status`;
    await expect(client.cekStatus('1302210001')).rejects.toThrow('wajib memakai HTTPS');
  });
});

describe('MockAkademikClient', () => {
  it('menganggap aktif hanya NIM yang ada di AKADEMIK_MOCK_ACTIVE_NIMS', async () => {
    process.env.AKADEMIK_MOCK_ACTIVE_NIMS = ' 1302210001 , TEST-DEV-0001 ,';
    const mock = new MockAkademikClient();
    await expect(mock.cekStatus('1302210001')).resolves.toBe(true);
    await expect(mock.cekStatus('TEST-DEV-0001')).resolves.toBe(true);
    await expect(mock.cekStatus('1302210099')).resolves.toBe(false);
    await expect(mock.cekStatus('')).resolves.toBe(false);
  });
});

describe('AkademikModule factory', () => {
  const providers = Reflect.getMetadata('providers', AkademikModule) as Array<{
    provide?: unknown; useFactory?: (http: unknown, mock: unknown) => unknown;
  }>;
  const factory = providers.find((p) => p.provide === AKADEMIK_CLIENT)!.useFactory!;
  const httpClient = new HttpAkademikClient();
  const mockClient = new MockAkademikClient();

  it('memilih adapter sesuai AKADEMIK_MODE', () => {
    process.env.NODE_ENV = 'development';
    process.env.AKADEMIK_MODE = 'mock';
    expect(factory(httpClient, mockClient)).toBe(mockClient);
    process.env.AKADEMIK_MODE = 'http';
    expect(factory(httpClient, mockClient)).toBe(httpClient);
  });

  it('mewajibkan adapter http di production dan menolak mode tak dikenal', () => {
    process.env.NODE_ENV = 'production';
    process.env.AKADEMIK_MODE = 'mock';
    expect(() => factory(httpClient, mockClient)).toThrow('AKADEMIK_MODE=http');
    process.env.NODE_ENV = 'development';
    process.env.AKADEMIK_MODE = 'lainnya';
    expect(() => factory(httpClient, mockClient)).toThrow('mock atau http');
  });
});
