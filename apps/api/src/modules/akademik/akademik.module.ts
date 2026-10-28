import { Module } from '@nestjs/common';
import { AKADEMIK_CLIENT } from './akademik.types';
import { AkademikService } from './akademik.service';
import { HttpAkademikClient } from './http-akademik.client';
import { MockAkademikClient } from './mock-akademik.client';
import Redis from 'ioredis';
import { AUTH_REDIS, AuthRedisLifecycle } from '../../common/auth/sso-state.lifecycle';

@Module({
  providers: [
    AkademikService,
    {
      provide: AUTH_REDIS,
      useFactory: () => {
        const redis = new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => attempt <= 2 ? 100 : null,
        });
        redis.on('error', () => undefined);
        return redis;
      },
    },
    AuthRedisLifecycle,
    HttpAkademikClient,
    MockAkademikClient,
    {
      provide: AKADEMIK_CLIENT,
      useFactory: (http: HttpAkademikClient, mock: MockAkademikClient) => {
        const mode = process.env.AKADEMIK_MODE || 'mock';
        if (process.env.NODE_ENV === 'production' && mode !== 'http') {
          throw new Error('Produksi wajib menggunakan AKADEMIK_MODE=http');
        }
        if (mode === 'mock') return mock;
        if (mode === 'http') return http;
        throw new Error('AKADEMIK_MODE harus bernilai mock atau http');
      },
      inject: [HttpAkademikClient, MockAkademikClient],
    },
  ],
  exports: [AkademikService],
})
export class AkademikModule {}
