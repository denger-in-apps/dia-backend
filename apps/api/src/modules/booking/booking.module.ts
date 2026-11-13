import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotifikasiModule } from '../notifikasi/notifikasi.module';
import { SesiModule } from '../sesi/sesi.module';
import { BookingController, DirektoriPsikologController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [CryptoModule, RealtimeModule, SesiModule, NotifikasiModule],
  controllers: [BookingController, DirektoriPsikologController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
