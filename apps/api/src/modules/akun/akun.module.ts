import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AkademikModule } from '../akademik/akademik.module';
import { AkunController } from './akun.controller';
import { AkunService } from './akun.service';

@Module({
  imports: [CryptoModule, AuditModule, AkademikModule],
  controllers: [AkunController],
  providers: [AkunService],
})
export class AkunModule {}
