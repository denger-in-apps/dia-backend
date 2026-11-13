import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage (SCRUM-200)', () => {
  it('counts hits atomically in Redis and reports block state in seconds', async () => {
    const redis = { status: 'ready', eval: jest.fn().mockResolvedValue([101, 30_500, 60_000]) };
    const storage = new RedisThrottlerStorage(redis as never);
    const record = await storage.increment('1.2.3.4', 60_000, 100, 60_000, 'default');
    expect(record).toEqual({ totalHits: 101, timeToExpire: 31, isBlocked: true, timeToBlockExpire: 60 });
    const [script, jumlahKunci, hitsKey, blokKey, ttl, limit, blok] = redis.eval.mock.calls[0];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(jumlahKunci).toBe(2);
    expect(hitsKey).toBe('throttle:default:1.2.3.4:hits');
    expect(blokKey).toBe('throttle:default:1.2.3.4:blok');
    expect([ttl, limit, blok]).toEqual([60_000, 100, 60_000]);
    storage.onApplicationShutdown();
  });

  it('falls back to per-instance memory when Redis is down instead of disabling limits', async () => {
    const redis = { status: 'ready', eval: jest.fn().mockRejectedValue(new Error('down')) };
    const storage = new RedisThrottlerStorage(redis as never);
    const first = await storage.increment('k', 60_000, 1, 60_000, 'default');
    const second = await storage.increment('k', 60_000, 1, 60_000, 'default');
    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(true);
    storage.onApplicationShutdown();
  });
});
