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
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BuatSumberDayaDto, DaftarSumberDayaQuery, UbahSumberDayaDto } from './sumber-daya.dto';
import { SumberDayaService } from './sumber-daya.service';

const uuid = () => new ParseUUIDPipe();
const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/**
 * Direktori publik (FR-MHS-10, FR-PSI-07). Sengaja `@Public()`: kontak layanan bantuan tidak
 * sensitif dan harus tetap terbuka bagi mahasiswa yang aksesnya dibatasi atau saat gangguan
 * SSO/akademik (02-backend.md §6). Tetap terkena rate limit global.
 */
@Controller('sumber-daya')
@Public()
export class SumberDayaController {
  constructor(private readonly sumberDaya: SumberDayaService) {}

  @Get()
  daftar(@Query() query: DaftarSumberDayaQuery) {
    return this.sumberDaya.daftarPublik(query.kategori);
  }

  @Get(':id')
  detail(@Param('id', uuid()) id: string) {
    return this.sumberDaya.detailPublik(id);
  }
}

/** Pengelolaan direktori oleh Dosen Admin (FR-ADM-03). */
@Controller('admin/sumber-daya')
@Roles(Role.DOSEN_ADMIN)
export class SumberDayaAdminController {
  constructor(private readonly sumberDaya: SumberDayaService) {}

  @Get()
  daftar(@Query() query: DaftarSumberDayaQuery) {
    return this.sumberDaya.daftarAdmin(query.kategori);
  }

  @Post()
  buat(@CurrentUser() admin: AuthenticatedUser, @Body() dto: BuatSumberDayaDto, @Req() request: Request) {
    return this.sumberDaya.buat(admin, dto, konteks(request));
  }

  @Patch(':id')
  ubah(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahSumberDayaDto, @Req() request: Request) {
    return this.sumberDaya.ubah(admin, id, dto, konteks(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapus(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request): Promise<void> {
    await this.sumberDaya.hapus(admin, id, konteks(request));
  }
}
