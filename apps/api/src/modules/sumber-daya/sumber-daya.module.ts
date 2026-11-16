import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { SumberDayaAdminController, SumberDayaController } from './sumber-daya.controller';
import { SumberDayaService } from './sumber-daya.service';

@Module({
  imports: [AuditModule],
  controllers: [SumberDayaController, SumberDayaAdminController],
  providers: [SumberDayaService],
})
export class SumberDayaModule {}
