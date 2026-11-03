import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AkunController } from './akun.controller';
import { AkunService } from './akun.service';

@Module({
  imports: [CryptoModule, AuditModule],
  controllers: [AkunController],
  providers: [AkunService],
})
export class AkunModule {}
