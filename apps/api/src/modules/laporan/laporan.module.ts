import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { REPORT_POOL } from './laporan.constants';
import { LaporanController } from './laporan.controller';
import { LaporanService } from './laporan.service';

@Injectable()
class ReportPoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REPORT_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Laporan agregat memakai koneksi terpisah role `denger_report` (04-database.md §6), bukan
 * DATABASE_POOL milik `denger_app`: least privilege ditegakkan oleh PostgreSQL.
 */
@Module({
  controllers: [LaporanController],
  providers: [
    {
      provide: REPORT_POOL,
      useFactory: () => {
        const connectionString = process.env.REPORT_DATABASE_URL;
        if (!connectionString) throw new Error('REPORT_DATABASE_URL wajib diisi');
        return new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000 });
      },
    },
    ReportPoolLifecycle,
    LaporanService,
  ],
})
export class LaporanModule {}
