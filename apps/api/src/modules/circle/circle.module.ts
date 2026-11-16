import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { CircleAdminController } from './circle-admin.controller';
import { CircleAdminService } from './circle-admin.service';
import { CircleController, KategoriMinatController, PreferensiMinatController } from './circle.controller';
import { RekomendasiService } from './rekomendasi.service';
import { CirclePesanService } from './circle-pesan.service';
import { CircleService } from './circle.service';

@Module({
  imports: [AuditModule],
  controllers: [KategoriMinatController, CircleController, CircleAdminController, PreferensiMinatController],
  providers: [CircleService, CirclePesanService, CircleAdminService, RekomendasiService],
})
export class CircleModule {}
