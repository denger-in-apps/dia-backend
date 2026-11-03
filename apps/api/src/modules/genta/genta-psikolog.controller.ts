import { Controller, Get, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { GentaPsikologService } from './genta-psikolog.service';

@Controller('psikolog/sos')
@Roles(Role.PSIKOLOG)
export class GentaPsikologController {
  constructor(private readonly genta: GentaPsikologService) {}

  @Get(':id/lokasi')
  lokasi(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.genta.lokasiSos(user, id, { ip: request.ip, userAgent: request.get('user-agent') });
  }
}
