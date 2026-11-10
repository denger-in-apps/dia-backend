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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import {
  BuatJadwalDto,
  BuatPsikologDto,
  DaftarJadwalQuery,
  DaftarPsikologQuery,
  UbahJadwalDto,
  UbahPsikologDto,
} from './admin-staf.dto';
import { AdminPsikologService } from './admin-psikolog.service';
import { JadwalJagaService } from './jadwal-jaga.service';

const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });
const uuid = () => new ParseUUIDPipe();

/** Kelola akun psikolog & jadwal jaga oleh Dosen Admin (FR-ADM-02). */
@Controller('admin')
@Roles(Role.DOSEN_ADMIN)
export class AdminStafController {
  constructor(
    private readonly psikolog: AdminPsikologService,
    private readonly jadwal: JadwalJagaService,
  ) {}

  @Get('psikolog')
  daftarPsikolog(@Query() query: DaftarPsikologQuery) {
    return this.psikolog.daftar(query);
  }

  @Get('psikolog/:id')
  detailPsikolog(@Param('id', uuid()) id: string) {
    return this.psikolog.detail(id);
  }

  /** Respons memuat `password_sementara` sekali saja; jangan di-cache. */
  @Post('psikolog')
  buatPsikolog(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: BuatPsikologDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.psikolog.buat(admin, dto, konteks(request));
  }

  @Patch('psikolog/:id')
  ubahPsikolog(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Body() dto: UbahPsikologDto,
    @Req() request: Request,
  ) {
    return this.psikolog.ubah(admin, id, dto, konteks(request));
  }

  @Post('psikolog/:id/aktifkan')
  @HttpCode(HttpStatus.OK)
  aktifkan(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request) {
    return this.psikolog.aktifkan(admin, id, konteks(request));
  }

  @Post('psikolog/:id/nonaktifkan')
  @HttpCode(HttpStatus.OK)
  nonaktifkan(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request) {
    return this.psikolog.nonaktifkan(admin, id, konteks(request));
  }

  @Post('psikolog/:id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.psikolog.resetPassword(admin, id, konteks(request));
  }

  @Get('jadwal-jaga')
  daftarJadwal(@Query() query: DaftarJadwalQuery) {
    return this.jadwal.daftar(query);
  }

  @Post('jadwal-jaga')
  buatJadwal(@CurrentUser() admin: AuthenticatedUser, @Body() dto: BuatJadwalDto, @Req() request: Request) {
    return this.jadwal.buat(admin, dto, konteks(request));
  }

  @Patch('jadwal-jaga/:id')
  ubahJadwal(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Body() dto: UbahJadwalDto,
    @Req() request: Request,
  ) {
    return this.jadwal.ubah(admin, id, dto, konteks(request));
  }

  @Delete('jadwal-jaga/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusJadwal(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request) {
    await this.jadwal.hapus(admin, id, konteks(request));
  }
}

/** Jadwal jaga milik psikolog yang login. */
@Controller('psikolog/jadwal-jaga')
@Roles(Role.PSIKOLOG)
export class PsikologJadwalController {
  constructor(private readonly jadwal: JadwalJagaService) {}

  @Get()
  milikSaya(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarJadwalQuery) {
    return this.jadwal.milikSaya(user, { dari: query.dari, sampai: query.sampai });
  }
}
