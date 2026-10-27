import { OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
export declare const AUTH_REDIS: unique symbol;
export declare class AuthRedisLifecycle implements OnApplicationShutdown {
    private readonly redis;
    constructor(redis: Redis);
    onApplicationShutdown(): Promise<void>;
}
