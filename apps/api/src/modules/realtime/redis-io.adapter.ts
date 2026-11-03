import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Adapter Socket.IO berbasis Redis pub/sub agar event realtime sampai ke klien
 * yang terhubung ke instance API mana pun (scale-out). Bila Redis tidak tersedia
 * saat start, aplikasi tetap jalan dengan adapter in-memory (cukup untuk satu instance).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly adapterLogger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<boolean> {
    const options = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: null,
    };
    const pub = new Redis({ ...options, retryStrategy: () => null });
    const sub = new Redis({ ...options, retryStrategy: () => null });
    pub.on('error', () => undefined);
    sub.on('error', () => undefined);
    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (error) {
      pub.disconnect();
      sub.disconnect();
      this.adapterLogger.warn(`Redis adapter Socket.IO tidak aktif (${(error as Error).message}); memakai adapter in-memory`);
      return false;
    }
    // Setelah tersambung, izinkan reconnect otomatis untuk gangguan sementara.
    pub.options.retryStrategy = (attempt) => Math.min(attempt * 200, 5000);
    sub.options.retryStrategy = (attempt) => Math.min(attempt * 200, 5000);
    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
    return true;
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close(server: unknown): Promise<void> {
    await super.close(server as never);
    await Promise.all(this.clients.map((client) => client.quit().catch(() => undefined)));
  }
}
