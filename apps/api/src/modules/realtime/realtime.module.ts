import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { NotifikasiController } from './notifikasi.controller';
import { PsikologGateway } from './psikolog.gateway';
import { SosNotifikasiService } from './sos-notifikasi.service';

@Module({
  imports: [AuthModule],
  controllers: [NotifikasiController],
  providers: [PsikologGateway, SosNotifikasiService],
  exports: [SosNotifikasiService],
})
export class RealtimeModule {}
