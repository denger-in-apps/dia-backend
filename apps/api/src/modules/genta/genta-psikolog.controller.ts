import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { GentaPsikologService, KonteksPermintaan } from './genta-psikolog.service';
import { DaftarSosQuery, UbahStatusSosDto } from './genta-psikolog.dto';

const konteks = (request: Request): KonteksPermintaan => ({
  ip: request.ip,
  userAgent: request.get('user-agent'),
});

/** Dashboard penanganan SOS untuk psikolog (PBI-08, FR-PSI-02). */
@Controller('psikolog/sos')
@Roles(Role.PSIKOLOG)
export class GentaPsikologController {
  constructor(private readonly genta: GentaPsikologService) {}

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarSosQuery) {
    return this.genta.daftar(user, query);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.genta.detail(user, id, konteks(request));
  }

  /** Ambil kasus (atomik). 200 bila berhasil/sudah milik sendiri, 409 bila diambil psikolog lain. */
  @Post(':id/ambil')
  @HttpCode(HttpStatus.OK)
  ambil(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.genta.ambil(user, id, konteks(request));
  }

  @Patch(':id/status')
  ubahStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UbahStatusSosDto,
    @Req() request: Request,
  ) {
    return this.genta.ubahStatus(user, id, dto, konteks(request));
  }

  @Get(':id/lokasi')
  lokasi(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.genta.lokasiSos(user, id, konteks(request));
  }
}
