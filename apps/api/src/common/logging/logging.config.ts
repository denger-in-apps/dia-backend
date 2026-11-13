import type { Params } from 'nestjs-pino';
import type { IncomingMessage } from 'http';

/** Path yang tidak perlu dicatat per request (probe berfrekuensi tinggi). */
const TANPA_LOG = new Set(['/health/live', '/health/ready']);

/**
 * Konfigurasi logger terstruktur (nestjs-pino, 02-backend.md §1). Prinsip: log tidak boleh
 * memuat rahasia atau data pribadi (02-backend.md §10):
 * - header Authorization/Cookie/Set-Cookie disamarkan;
 * - query string dibuang dari URL (callback SSO membawa `code`/`state`);
 * - body request/respons tidak pernah dicatat.
 */
export function konfigurasiLogger(env: NodeJS.ProcessEnv = process.env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug'),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.headers["x-api-key"]',
        ],
        censor: '[DISAMARKAN]',
      },
      autoLogging: { ignore: (req: IncomingMessage) => TANPA_LOG.has((req.url ?? '').split('?')[0]) },
      serializers: {
        req: (req: { id?: unknown; method?: string; url?: string; remoteAddress?: string; headers?: Record<string, unknown> }) => ({
          id: req.id,
          method: req.method,
          url: (req.url ?? '').split('?')[0],
          remoteAddress: req.remoteAddress,
          userAgent: req.headers?.['user-agent'],
        }),
      },
    },
  };
}
