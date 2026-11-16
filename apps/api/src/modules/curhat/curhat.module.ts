import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { EskalasiModule } from '../eskalasi/eskalasi.module';
import { CurhatController } from './curhat.controller';
import { CurhatService } from './curhat.service';

@Module({
  imports: [CryptoModule, EskalasiModule],
  controllers: [CurhatController],
  providers: [CurhatService],
})
export class CurhatModule {}
