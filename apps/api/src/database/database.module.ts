import { Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const DATABASE_POOL = Symbol('DATABASE_POOL');

@Injectable()
export class DatabasePoolLifecycle implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error('DATABASE_URL wajib diisi');
        return new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
      },
    },
    {
      provide: DatabasePoolLifecycle,
      useFactory: (pool: Pool) => new DatabasePoolLifecycle(pool),
      inject: [DATABASE_POOL],
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
