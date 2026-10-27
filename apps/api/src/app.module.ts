import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './common/health/health.module';
import { CryptoModule } from './common/crypto/crypto.module';

@Module({
  imports: [HealthModule, CryptoModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
