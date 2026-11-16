import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { CircleAdminController } from './circle-admin.controller';
import { CircleAdminService } from './circle-admin.service';
import { CircleController, KategoriMinatController } from './circle.controller';
import { CirclePesanService } from './circle-pesan.service';
import { CircleService } from './circle.service';

@Module({
  imports: [AuditModule],
  controllers: [KategoriMinatController, CircleController, CircleAdminController],
  providers: [CircleService, CirclePesanService, CircleAdminService],
})
export class CircleModule {}
