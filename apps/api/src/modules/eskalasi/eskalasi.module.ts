import { BullModule } from '@nestjs/bullmq';
import { Module, Provider } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ESKALASI_QUEUE } from './eskalasi.constants';
import { EskalasiProcessor } from './eskalasi.processor';
import { EskalasiSchedulerService } from './eskalasi-scheduler.service';
import { EskalasiService } from './eskalasi.service';
import { EskalasiSweeper } from './eskalasi.sweeper';
import { KonfigurasiSosService } from './konfigurasi-sos.service';

const redisConnection = () => ({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  // Disyaratkan BullMQ untuk koneksi worker (blocking).
  maxRetriesPerRequest: null,
});

/** Worker dapat dimatikan per instance (mis. instance khusus HTTP) dengan ESKALASI_WORKER_AKTIF=false. */
const workerProviders: Provider[] = process.env.ESKALASI_WORKER_AKTIF === 'false' ? [] : [EskalasiProcessor];

@Module({
  imports: [
    RealtimeModule,
    BullModule.forRootAsync({ useFactory: () => ({ connection: redisConnection() }) }),
    BullModule.registerQueue({
      name: ESKALASI_QUEUE,
      // Producer gagal cepat saat Redis putus agar fallback sweeper DB yang bekerja.
      connection: { ...redisConnection(), enableOfflineQueue: false },
    }),
  ],
  providers: [
    KonfigurasiSosService,
    EskalasiService,
    EskalasiSchedulerService,
    EskalasiSweeper,
    ...workerProviders,
  ],
  exports: [EskalasiSchedulerService, EskalasiService, KonfigurasiSosService],
})
export class EskalasiModule {}
