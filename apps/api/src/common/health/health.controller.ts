import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { Public } from '../auth/public.decorator';
import { AUTH_REDIS } from '../auth/sso-state.lifecycle';
import { DATABASE_POOL } from '../../database/database.module';
import { ensureRedisConnection } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2000;

type CheckStatus = 'ok' | 'error';

@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  @Get('health/live')
  @Public()
  live() {
    return { status: 'ok' };
  }

  /** Siap menerima trafik hanya bila PostgreSQL dan Redis dapat dijangkau. */
  @Get('health/ready')
  @Public()
  async ready() {
    const [database, redis] = await Promise.all([
      this.check(() => this.pool.query('SELECT 1')),
      this.check(async () => {
        await ensureRedisConnection(this.redis);
        await this.redis.ping();
      }),
    ]);
    const body = { status: database === 'ok' && redis === 'ok' ? 'ok' : 'error', checks: { database, redis } };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch {
      return 'error';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
