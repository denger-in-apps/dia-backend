import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { MasterDataController } from './master-data.controller';
import { MasterDataService } from './master-data.service';

@Module({
  imports: [AuditModule],
  controllers: [MasterDataController],
  providers: [MasterDataService],
})
export class MasterDataModule {}
