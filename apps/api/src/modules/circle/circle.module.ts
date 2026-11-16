import { Module } from '@nestjs/common';
import { CircleController, KategoriMinatController } from './circle.controller';
import { CirclePesanService } from './circle-pesan.service';
import { CircleService } from './circle.service';

@Module({
  controllers: [KategoriMinatController, CircleController],
  providers: [CircleService, CirclePesanService],
})
export class CircleModule {}
