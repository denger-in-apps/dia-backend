import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { GentaService } from './genta.service';
import { BuatSosDto } from './genta.dto';

@Controller('genta/sos')
@Roles(Role.MAHASISWA)
export class GentaController {
  constructor(private readonly genta: GentaService) {}

  /** Langkah 1: minta token konfirmasi + daftar pilihan situasi + info hotline. */
  @Post('konfirmasi')
  @HttpCode(HttpStatus.OK)
  mintaKonfirmasi(@CurrentUser() user: AuthenticatedUser) {
    return this.genta.mintaKonfirmasi(user.id);
  }

  /** Langkah 2: kirim SOS. 201 bila SOS baru, 200 bila SOS aktif sudah ada (idempoten). */
  @Post()
  async buatSos(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BuatSosDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const hasil = await this.genta.buatSos(user.id, dto);
    response.status(hasil.baru ? HttpStatus.CREATED : HttpStatus.OK);
    return hasil;
  }

  @Get('aktif')
  statusAktif(@CurrentUser() user: AuthenticatedUser) {
    return this.genta.statusAktif(user.id);
  }

  @Post(':id/batal')
  @HttpCode(HttpStatus.OK)
  batalkan(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.genta.batalkan(user.id, id);
  }
}
