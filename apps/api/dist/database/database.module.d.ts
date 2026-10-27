import { OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
export declare const DATABASE_POOL: unique symbol;
export declare class DatabasePoolLifecycle implements OnApplicationShutdown {
    private readonly pool;
    constructor(pool: Pool);
    onApplicationShutdown(): Promise<void>;
}
export declare class DatabaseModule {
}
