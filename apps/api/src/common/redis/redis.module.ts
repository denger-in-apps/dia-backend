import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { AUTH_REDIS, AuthRedisLifecycle } from '../auth/sso-state.lifecycle';

/**
 * Satu-satunya provider koneksi Redis. Modul lain meng-import modul ini
 * agar tidak membuat klien Redis ganda (dan lifecycle shutdown ganda).
 */
@Module({
  providers: [
    {
      provide: AUTH_REDIS,
      useFactory: () => {
        const redis = new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => (attempt <= 2 ? 100 : null),
        });
        redis.on('error', () => undefined);
        return redis;
      },
    },
    AuthRedisLifecycle,
  ],
  exports: [AUTH_REDIS],
})
export class RedisModule {}

/**
 * Menghubungkan klien lazy bila belum pernah tersambung, atau menyambung ulang
 * setelah retryStrategy menyerah (status `end`). Tanpa ini satu gangguan Redis
 * singkat membuat klien mati permanen sampai proses di-restart.
 */
export async function ensureRedisConnection(redis: Redis): Promise<void> {
  if (redis.status !== 'wait' && redis.status !== 'end') return;
  try {
    await redis.connect();
  } catch (error) {
    // Pemanggil paralel bisa memicu "already connecting"; itu bukan kegagalan.
    if (!['connect', 'connecting', 'ready'].includes(redis.status)) throw error;
  }
}
