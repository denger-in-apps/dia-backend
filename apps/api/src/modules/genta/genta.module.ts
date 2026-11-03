import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { RedisModule } from '../../common/redis/redis.module';
import { GentaController } from './genta.controller';
import { GentaService } from './genta.service';
import { SosKonfirmasiService } from './sos-konfirmasi.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [GentaController],
  providers: [GentaService, SosKonfirmasiService],
  exports: [GentaService],
})
export class GentaModule {}
