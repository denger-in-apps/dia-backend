import pino from 'pino';
import { Writable } from 'stream';
import { konfigurasiLogger } from './logging.config';
import { swaggerAktif } from './swagger';

describe('Logging & Swagger (SCRUM-200)', () => {
  it('redacts credentials, strips query strings and never logs bodies', () => {
    const { pinoHttp } = konfigurasiLogger({ NODE_ENV: 'production' }) as { pinoHttp: Record<string, any> };
    const baris: string[] = [];
    const logger = pino(
      { redact: pinoHttp.redact, serializers: pinoHttp.serializers },
      new Writable({ write(chunk, _encoding, cb) { baris.push(chunk.toString()); cb(); } }),
    );
    logger.info({
      req: {
        id: 1, method: 'GET', url: '/api/v1/auth/sso/callback?code=rahasia&state=s',
        headers: { authorization: 'Bearer token-rahasia', cookie: 'refresh_token=x', 'user-agent': 'ua' },
        body: { password: 'p' },
      },
    });
    const log = baris.join('');
    expect(log).toContain('/api/v1/auth/sso/callback');
    for (const rahasia of ['code=rahasia', 'token-rahasia', 'refresh_token=x', '"password"']) {
      expect(log).not.toContain(rahasia);
    }
    expect(pinoHttp.level).toBe('info');
    expect(pinoHttp.redact.paths).toEqual(expect.arrayContaining(['req.headers.authorization', 'res.headers["set-cookie"]']));
    expect(pinoHttp.autoLogging.ignore({ url: '/health/ready' })).toBe(true);
  });

  it('enables Swagger outside production unless explicitly toggled', () => {
    expect(swaggerAktif({ NODE_ENV: 'development' })).toBe(true);
    expect(swaggerAktif({ NODE_ENV: 'production' })).toBe(false);
    expect(swaggerAktif({ NODE_ENV: 'production', SWAGGER_AKTIF: 'true' })).toBe(true);
    expect(swaggerAktif({ NODE_ENV: 'development', SWAGGER_AKTIF: 'false' })).toBe(false);
  });
});
