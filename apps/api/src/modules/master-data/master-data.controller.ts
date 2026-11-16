import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BuatTemplateDto, DaftarTemplateQuery, KategoriMinatDto, UbahKategoriMinatDto } from './master-data.dto';
import { MasterDataService } from './master-data.service';

const uuid = () => new ParseUUIDPipe();
const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Master data: kategori minat & template kuesioner (PBI-20 / SCRUM-275, FR-ADM-07). */
@Controller('admin')
@Roles(Role.DOSEN_ADMIN)
export class MasterDataController {
  constructor(private readonly master: MasterDataService) {}

  @Get('kategori-minat')
  daftarKategori() {
    return this.master.daftarKategori();
  }

  @Post('kategori-minat')
  buatKategori(@CurrentUser() admin: AuthenticatedUser, @Body() dto: KategoriMinatDto, @Req() request: Request) {
    return this.master.buatKategori(admin, dto.nama, konteks(request));
  }

  @Patch('kategori-minat/:id')
  ubahKategori(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahKategoriMinatDto, @Req() request: Request) {
    return this.master.ubahKategori(admin, id, dto, konteks(request));
  }

  @Delete('kategori-minat/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusKategori(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request): Promise<void> {
    await this.master.hapusKategori(admin, id, konteks(request));
  }

  @Get('template-kuesioner')
  daftarTemplate(@Query() query: DaftarTemplateQuery) {
    return this.master.daftarTemplate(query.kode);
  }

  @Get('template-kuesioner/:id')
  detailTemplate(@Param('id', uuid()) id: string) {
    return this.master.detailTemplate(id);
  }

  @Post('template-kuesioner')
  buatTemplate(@CurrentUser() admin: AuthenticatedUser, @Body() dto: BuatTemplateDto, @Req() request: Request) {
    return this.master.buatTemplate(admin, dto, konteks(request));
  }

  @Post('template-kuesioner/:id/aktifkan')
  @HttpCode(HttpStatus.OK)
  aktifkanTemplate(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request) {
    return this.master.aktifkanTemplate(admin, id, konteks(request));
  }

  @Delete('template-kuesioner/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapusTemplate(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() request: Request): Promise<void> {
    await this.master.hapusTemplate(admin, id, konteks(request));
  }
}
