import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { AlasanDto, DaftarPesanQuery, KirimPesanCircleDto } from './circle.dto';
import { CirclePendampingService } from './circle-pendamping.service';

const uuid = () => new ParseUUIDPipe();
const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Dashboard pendampingan & moderasi Circle (PBI-18 / SCRUM-267, FR-PSI-06). */
@Controller('psikolog/circles')
@Roles(Role.PSIKOLOG)
export class CirclePendampingController {
  constructor(private readonly pendamping: CirclePendampingService) {}

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser) {
    return this.pendamping.daftar(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.pendamping.detail(user, id);
  }

  @Get(':id/pesan')
  daftarPesan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Query() query: DaftarPesanQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.pendamping.daftarPesan(user, id, query.sebelum, query.limit);
  }

  @Post(':id/pesan')
  kirimPesan(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: KirimPesanCircleDto) {
    return this.pendamping.kirimPesan(user, id, dto.isi);
  }

  /** Sembunyikan pesan + alasan (02-backend.md §8.5: `/psikolog/circles/:id/pesan/:pid/moderasi`). */
  @Post(':id/pesan/:pid/moderasi')
  @HttpCode(HttpStatus.OK)
  sembunyikan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Param('pid', uuid()) pid: string,
    @Body() dto: AlasanDto,
    @Req() request: Request,
  ) {
    return this.pendamping.sembunyikan(user, id, pid, dto.alasan, konteks(request));
  }

  @Post(':id/pesan/:pid/pulihkan')
  @HttpCode(HttpStatus.OK)
  pulihkan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Param('pid', uuid()) pid: string,
    @Req() request: Request,
  ) {
    return this.pendamping.pulihkan(user, id, pid, konteks(request));
  }
}
