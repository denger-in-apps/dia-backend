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
  Put,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BuatPenerimaEskalasiDto, UbahKonfigurasiSosDto, UbahPenerimaEskalasiDto } from './admin-eskalasi.dto';
import { KonfigurasiSosService } from './konfigurasi-sos.service';
import { PenerimaEskalasiService } from './penerima-eskalasi.service';

const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Konfigurasi eskalasi SOS oleh Dosen Admin (FR-ADM-05). */
@Controller('admin')
@Roles(Role.DOSEN_ADMIN)
export class AdminEskalasiController {
  constructor(
    private readonly konfigurasi: KonfigurasiSosService,
    private readonly penerima: PenerimaEskalasiService,
  ) {}

  @Get('konfigurasi-sos')
  ambilKonfigurasi() {
    return this.konfigurasi.ambil();
  }

  /** Field yang tidak dikirim tidak berubah. */
  @Put('konfigurasi-sos')
  ubahKonfigurasi(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UbahKonfigurasiSosDto,
    @Req() request: Request,
  ) {
    return this.konfigurasi.ubah(admin, dto, konteks(request));
  }

  @Get('penerima-eskalasi')
  daftarPenerima() {
    return this.penerima.daftar();
  }

  @Post('penerima-eskalasi')
  buatPenerima(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: BuatPenerimaEskalasiDto,
    @Req() request: Request,
  ) {
    return this.penerima.buat(admin, dto, konteks(request));
  }

  @Patch('penerima-eskalasi/:id')
  ubahPenerima(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UbahPenerimaEskalasiDto,
    @Req() request: Request,
  ) {
    return this.penerima.ubah(admin, id, dto, konteks(request));
  }

  @Delete('penerima-eskalasi/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusPenerima(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.penerima.hapus(admin, id, konteks(request));
  }
}
