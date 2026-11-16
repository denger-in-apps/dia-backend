import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { CekMandiriService } from './cek-mandiri.service';
import { KirimCekMandiriDto, RiwayatCekQuery } from './cek-mandiri.dto';

/** Cek mandiri PHQ-9 & GAD-7 (PBI-15, FR-MHS-08). Hanya mahasiswa, hanya data milik sendiri. */
@Controller('cek-mandiri')
@Roles(Role.MAHASISWA)
export class CekMandiriController {
  constructor(private readonly cek: CekMandiriService) {}

  @Get('template')
  template() {
    return this.cek.template();
  }

  @Post()
  kirim(@CurrentUser() user: AuthenticatedUser, @Body() dto: KirimCekMandiriDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.cek.kirim(user.id, dto);
  }

  @Get('riwayat')
  riwayat(@CurrentUser() user: AuthenticatedUser, @Query() query: RiwayatCekQuery, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.cek.riwayat(user.id, query.limit);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.cek.detail(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapus(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.cek.hapus(user.id, id);
  }
}
