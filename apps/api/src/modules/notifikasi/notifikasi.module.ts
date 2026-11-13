import { Module } from '@nestjs/common';
import { ConsoleEmailProvider } from './email/console-email.provider';
import { EMAIL_PROVIDER } from './email/email.provider';
import { HttpEmailProvider } from './email/http-email.provider';
import { PengingatService } from './pengingat.service';
import { PengingatWorker } from './pengingat.worker';

/** Pengingat sesi (PBI-14). Daftar notifikasi in-app tetap di `realtime/notifikasi.controller.ts`. */
@Module({
  providers: [
    ConsoleEmailProvider,
    HttpEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useFactory: (consoleEmail: ConsoleEmailProvider, httpEmail: HttpEmailProvider) => {
        const mode = process.env.EMAIL_PROVIDER || 'console';
        if (process.env.NODE_ENV === 'production' && mode !== 'http') {
          throw new Error('Produksi wajib menggunakan EMAIL_PROVIDER=http');
        }
        if (mode === 'console') return consoleEmail;
        if (mode === 'http') return httpEmail;
        throw new Error('EMAIL_PROVIDER harus bernilai console atau http');
      },
      inject: [ConsoleEmailProvider, HttpEmailProvider],
    },
    PengingatService,
    ...(process.env.PENGINGAT_WORKER_AKTIF === 'false' ? [] : [PengingatWorker]),
  ],
  exports: [PengingatService],
})
export class NotifikasiModule {}
