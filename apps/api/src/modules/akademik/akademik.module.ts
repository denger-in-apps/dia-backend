import { Module } from '@nestjs/common';
import { AKADEMIK_CLIENT } from './akademik.types';
import { AkademikService } from './akademik.service';
import { HttpAkademikClient } from './http-akademik.client';
import { MockAkademikClient } from './mock-akademik.client';
import { RedisModule } from '../../common/redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [
    AkademikService,
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
