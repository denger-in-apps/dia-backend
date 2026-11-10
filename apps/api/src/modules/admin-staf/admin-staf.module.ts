import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminPsikologService } from './admin-psikolog.service';
import { AdminStafController, PsikologJadwalController } from './admin-staf.controller';
import { JadwalJagaService } from './jadwal-jaga.service';
import { StatusJagaSync } from './status-jaga.sync';

@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [AdminStafController, PsikologJadwalController],
  providers: [AdminPsikologService, JadwalJagaService, StatusJagaSync],
})
export class AdminStafModule {}
