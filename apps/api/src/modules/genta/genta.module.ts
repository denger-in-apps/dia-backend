import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuditModule } from '../../common/audit/audit.module';
import { GentaController } from './genta.controller';
import { GentaService } from './genta.service';
import { SosKonfirmasiService } from './sos-konfirmasi.service';
import { SosLokasiService } from './sos-lokasi.service';
import { GentaPsikologController } from './genta-psikolog.controller';
import { GentaPsikologService } from './genta-psikolog.service';

@Module({
  imports: [AuthModule, RedisModule, CryptoModule, AuditModule],
  controllers: [GentaController, GentaPsikologController],
  providers: [GentaService, GentaPsikologService, SosKonfirmasiService, SosLokasiService],
  exports: [GentaService],
})
export class GentaModule {}
