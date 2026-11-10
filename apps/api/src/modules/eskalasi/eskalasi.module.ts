import { BullModule } from '@nestjs/bullmq';
import { Module, Provider } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AdminEskalasiController } from './admin-eskalasi.controller';
import { PenerimaEskalasiService } from './penerima-eskalasi.service';
import { EskalasiTindakanService } from './eskalasi-tindakan.service';
import { SMS_PROVIDER } from './sms/sms.provider';
import { ConsoleSmsProvider } from './sms/console-sms.provider';
import { HttpSmsProvider } from './sms/http-sms.provider';
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
    CryptoModule,
    AuditModule,
    BullModule.forRootAsync({ useFactory: () => ({ connection: redisConnection() }) }),
    BullModule.registerQueue({
      name: ESKALASI_QUEUE,
      // Producer gagal cepat saat Redis putus agar fallback sweeper DB yang bekerja.
      connection: { ...redisConnection(), enableOfflineQueue: false },
    }),
  ],
  controllers: [AdminEskalasiController],
  providers: [
    KonfigurasiSosService,
    PenerimaEskalasiService,
    EskalasiService,
    EskalasiSchedulerService,
    EskalasiSweeper,
    EskalasiTindakanService,
    ConsoleSmsProvider,
    HttpSmsProvider,
    {
      provide: SMS_PROVIDER,
      useFactory: (consoleSms: ConsoleSmsProvider, httpSms: HttpSmsProvider) => {
        const mode = process.env.SMS_PROVIDER || 'console';
        if (process.env.NODE_ENV === 'production' && mode !== 'http') {
          throw new Error('Produksi wajib menggunakan SMS_PROVIDER=http');
        }
        if (mode === 'console') return consoleSms;
        if (mode === 'http') return httpSms;
        throw new Error('SMS_PROVIDER harus bernilai console atau http');
      },
      inject: [ConsoleSmsProvider, HttpSmsProvider],
    },
    ...workerProviders,
  ],
  exports: [EskalasiSchedulerService, EskalasiService, KonfigurasiSosService],
})
export class EskalasiModule {}
