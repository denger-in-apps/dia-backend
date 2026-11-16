import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import {
  BuatCircleAdminDto,
  DaftarCircleAdminQuery,
  KategoriMinatDto,
  SetujuiCircleDto,
  UbahCircleAdminDto,
  UbahKategoriMinatDto,
} from './circle-admin.dto';
import { AlasanDto } from './circle.dto';
import { CircleAdminService } from './circle-admin.service';

const uuid = () => new ParseUUIDPipe();
const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Persetujuan & pengelolaan Circle dan kategori minat oleh Dosen Admin (PBI-17 / SCRUM-264, FR-ADM-07). */
@Controller('admin')
@Roles(Role.DOSEN_ADMIN)
export class CircleAdminController {
  constructor(private readonly circle: CircleAdminService) {}

  @Get('circles')
  daftar(@Query() query: DaftarCircleAdminQuery) {
    return this.circle.daftar(query);
  }

  @Post('circles')
  buat(@CurrentUser() admin: AuthenticatedUser, @Body() dto: BuatCircleAdminDto, @Req() request: Request) {
    return this.circle.buat(admin, dto, konteks(request));
  }

  @Get('circles/:id')
  detail(@Param('id', uuid()) id: string) {
    return this.circle.detail(id);
  }

  @Patch('circles/:id')
  ubah(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahCircleAdminDto, @Req() request: Request) {
    return this.circle.ubah(admin, id, dto, konteks(request));
  }

  @Post('circles/:id/setujui')
  @HttpCode(HttpStatus.OK)
  setujui(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: SetujuiCircleDto, @Req() request: Request) {
    return this.circle.setujui(admin, id, dto.id_psikolog, konteks(request));
  }

  @Post('circles/:id/tolak')
  @HttpCode(HttpStatus.OK)
  tolak(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AlasanDto, @Req() request: Request) {
    return this.circle.tolak(admin, id, dto.alasan, konteks(request));
  }

  @Post('circles/:id/tutup')
  @HttpCode(HttpStatus.OK)
  tutup(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request) {
    return this.circle.tutup(admin, id, konteks(request));
  }

  @Get('kategori-minat')
  daftarKategori() {
    return this.circle.daftarKategori();
  }

  @Post('kategori-minat')
  buatKategori(@CurrentUser() admin: AuthenticatedUser, @Body() dto: KategoriMinatDto, @Req() request: Request) {
    return this.circle.buatKategori(admin, dto.nama, konteks(request));
  }

  @Patch('kategori-minat/:id')
  ubahKategori(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahKategoriMinatDto, @Req() request: Request) {
    return this.circle.ubahKategori(admin, id, dto, konteks(request));
  }
}
