import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

export const AUTH_REDIS = Symbol('AUTH_REDIS');

@Injectable()
export class AuthRedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(AUTH_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') await this.redis.quit();
    else this.redis.disconnect();
  }
}
