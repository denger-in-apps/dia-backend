import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './common/health/health.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuthModule } from './common/auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { AkademikModule } from './modules/akademik/akademik.module';
import { AkunModule } from './modules/akun/akun.module';
import { GentaModule } from './modules/genta/genta.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminStafModule } from './modules/admin-staf/admin-staf.module';
import { BookingModule } from './modules/booking/booking.module';

@Module({
  imports: [
    ScheduleModule.forRoot(), HealthModule, CryptoModule, DatabaseModule, AkademikModule, AuthModule, AkunModule,
    GentaModule, RealtimeModule, AdminStafModule, BookingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
