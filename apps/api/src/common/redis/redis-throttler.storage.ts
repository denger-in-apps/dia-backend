import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { ensureRedisConnection } from './redis.module';

/** INCR + PEXPIRE + blok dalam satu langkah atomik (aman untuk banyak instance API). */
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('PTTL', KEYS[2])
if blocked <= 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = tonumber(ARGV[3])
end
return {hits, ttl, blocked}
`;

/**
 * Storage `@nestjs/throttler` di Redis (SCRUM-200) sehingga batas per IP berlaku lintas
 * instance, bukan per proses. Bila Redis tidak tersedia, jatuh ke storage in-memory per
 * instance (degradasi, bukan mematikan rate limit dan bukan memblokir semua request).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly cadangan = new ThrottlerStorageService();

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      await ensureRedisConnection(this.redis);
      const prefix = `throttle:${throttlerName}:${key}`;
      const [hits, ttlMs, blockedMs] = (await this.redis.eval(
        SCRIPT, 2, `${prefix}:hits`, `${prefix}:blok`, ttl, limit, blockDuration,
      )) as [number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
        isBlocked: blockedMs > 0,
        timeToBlockExpire: Math.max(0, Math.ceil(blockedMs / 1000)),
      };
    } catch (error) {
      this.logger.warn(`Rate limit memakai memori lokal (Redis tidak tersedia): ${(error as Error).message}`);
      return this.cadangan.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onApplicationShutdown(): void {
    this.cadangan.onApplicationShutdown();
  }
}
