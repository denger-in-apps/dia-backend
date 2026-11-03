import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../common/auth/refresh-cookie';
import { AkunService } from './akun.service';
import {
  CreateKontakDaruratDto,
  HapusAkunDto,
  UpdateKontakDaruratDto,
  UpdateProfilDto,
} from './akun.dto';

@Controller('me')
@Roles(Role.MAHASISWA)
export class AkunController {
  constructor(private readonly akun: AkunService) {}

  @Get()
  profil(@CurrentUser() user: AuthenticatedUser) {
    return this.akun.profil(user.id);
  }

  @Patch()
  ubahProfil(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfilDto) {
    return this.akun.ubahProfil(user.id, dto);
  }

  @Get('export')
  async ekspor(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = await this.akun.ekspor(user.id, {
      ip: request.ip,
      userAgent: request.get('user-agent'),
    });
    response.setHeader('Content-Disposition', 'attachment; filename="data-saya.json"');
    response.setHeader('Cache-Control', 'no-store');
    return data;
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusAkun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _dto: HapusAkunDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.akun.hapusAkun(user.id, {
      ip: request.ip,
      userAgent: request.get('user-agent'),
    });
    response.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
  }

  @Get('kontak-darurat')
  daftarKontak(@CurrentUser() user: AuthenticatedUser) {
    return this.akun.daftarKontak(user.id);
  }

  @Post('kontak-darurat')
  tambahKontak(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateKontakDaruratDto) {
    return this.akun.tambahKontak(user.id, dto);
  }

  @Patch('kontak-darurat/:id')
  ubahKontak(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateKontakDaruratDto,
  ) {
    return this.akun.ubahKontak(user.id, id, dto);
  }

  @Delete('kontak-darurat/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusKontak(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.akun.hapusKontak(user.id, id);
  }
}
