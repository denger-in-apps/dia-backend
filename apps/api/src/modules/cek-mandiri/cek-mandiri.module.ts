import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { EskalasiModule } from '../eskalasi/eskalasi.module';
import { CekMandiriController } from './cek-mandiri.controller';
import { CekMandiriService } from './cek-mandiri.service';

@Module({
  imports: [CryptoModule, EskalasiModule],
  controllers: [CekMandiriController],
  providers: [CekMandiriService],
})
export class CekMandiriModule {}
