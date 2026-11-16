import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/auth.types';
import { PeriodeQuery } from './laporan.dto';
import { LaporanService } from './laporan.service';

/** Laporan agregat anonim (PBI-20 / SCRUM-274, FR-ADM-04). Tidak menerima id individu apa pun. */
@Controller('admin/laporan')
@Roles(Role.DOSEN_ADMIN)
export class LaporanController {
  constructor(private readonly laporan: LaporanService) {}

  @Get('ringkasan')
  ringkasan(@Query() q: PeriodeQuery) {
    return this.laporan.ringkasan(q.dari, q.sampai);
  }

  @Get('genta')
  genta(@Query() q: PeriodeQuery) {
    return this.laporan.genta(q.dari, q.sampai);
  }

  @Get('cek-mandiri')
  cekMandiri(@Query() q: PeriodeQuery) {
    return this.laporan.cekMandiri(q.dari, q.sampai);
  }

  @Get('sesi')
  sesi(@Query() q: PeriodeQuery) {
    return this.laporan.sesi(q.dari, q.sampai);
  }

  @Get('curhat')
  curhat(@Query() q: PeriodeQuery) {
    return this.laporan.curhat(q.dari, q.sampai);
  }

  @Get('circle')
  circle() {
    return this.laporan.circle();
  }
}
