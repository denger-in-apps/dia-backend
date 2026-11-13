import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BookingController, DirektoriPsikologController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [CryptoModule, RealtimeModule],
  controllers: [BookingController, DirektoriPsikologController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
