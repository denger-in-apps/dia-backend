import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { AuditModule } from '../../common/audit/audit.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import {
  ConsentCatatanController,
  KunciE2eeController,
  RiwayatPsikologController,
  RuangSesiController,
  SesiPsikologController,
} from './sesi.controller';
import { RingkasanService } from './ringkasan.service';
import { RuangSesiService } from './ruang-sesi.service';
import { SesiGateway } from './sesi.gateway';
import { SesiPsikologService } from './sesi-psikolog.service';

@Module({
  imports: [AuthModule, AuditModule, CryptoModule],
  controllers: [
    KunciE2eeController, RuangSesiController, SesiPsikologController, RiwayatPsikologController, ConsentCatatanController,
  ],
  providers: [RuangSesiService, SesiPsikologService, RingkasanService, SesiGateway],
  exports: [SesiGateway, RuangSesiService],
})
export class SesiModule {}
