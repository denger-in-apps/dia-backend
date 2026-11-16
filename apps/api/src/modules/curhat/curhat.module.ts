import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { EskalasiModule } from '../eskalasi/eskalasi.module';
import { CurhatController } from './curhat.controller';
import { CurhatService } from './curhat.service';
import { CurhatPsikologController } from './curhat-psikolog.controller';
import { CurhatPsikologService } from './curhat-psikolog.service';

@Module({
  imports: [CryptoModule, EskalasiModule, AuditModule],
  controllers: [CurhatController, CurhatPsikologController],
  providers: [CurhatService, CurhatPsikologService],
})
export class CurhatModule {}
