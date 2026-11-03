import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './common/health/health.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuthModule } from './common/auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { AkademikModule } from './modules/akademik/akademik.module';
import { AkunModule } from './modules/akun/akun.module';

@Module({
  imports: [HealthModule, CryptoModule, DatabaseModule, AkademikModule, AuthModule, AkunModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
