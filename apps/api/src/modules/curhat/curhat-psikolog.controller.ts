import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BalasCurhatDto, DaftarCurhatPsikologQuery } from './curhat.dto';
import { CurhatPsikologService, KonteksPermintaan } from './curhat-psikolog.service';

const konteks = (request: Request): KonteksPermintaan => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Ruang curhat — psikolog membaca (tanpa identitas) dan memberi saran (PBI-16 / SCRUM-261, FR-PSI-05). */
@Controller('psikolog/curhat')
@Roles(Role.PSIKOLOG)
export class CurhatPsikologController {
  constructor(private readonly curhat: CurhatPsikologService) {}

  @Get()
  daftar(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DaftarCurhatPsikologQuery,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.curhat.daftar(user, query, konteks(request));
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.curhat.detail(user, id, konteks(request));
  }

  @Post(':id/balasan')
  balas(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: BalasCurhatDto,
    @Req() request: Request,
  ) {
    return this.curhat.balas(user, id, dto.isi, konteks(request));
  }
}
