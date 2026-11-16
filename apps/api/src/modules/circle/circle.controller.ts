import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import {
  AjukanCircleDto,
  DaftarPesanQuery,
  KirimPesanCircleDto,
  PreferensiMinatDto,
  RekomendasiQuery,
  TelusuriCircleQuery,
  UbahKeanggotaanDto,
} from './circle.dto';
import { CircleService } from './circle.service';
import { RekomendasiService } from './rekomendasi.service';

const uuid = () => new ParseUUIDPipe();

/** Kategori minat aktif (semua role terautentikasi). */
@Controller('kategori-minat')
export class KategoriMinatController {
  constructor(private readonly circle: CircleService) {}

  @Get()
  daftar() {
    return this.circle.kategori();
  }
}

/** Circle — mahasiswa (PBI-17 / SCRUM-263, FR-MHS-06). Route statis dideklarasikan sebelum `:id`. */
@Controller('circles')
@Roles(Role.MAHASISWA)
export class CircleController {
  constructor(
    private readonly circle: CircleService,
    private readonly rekomendasi: RekomendasiService,
  ) {}

  @Get()
  telusuri(@CurrentUser() user: AuthenticatedUser, @Query() query: TelusuriCircleQuery) {
    return this.circle.telusuri(user.id, query);
  }

  /** Rekomendasi Circle (PBI-18 / SCRUM-266, FR-MHS-07). */
  @Get('rekomendasi')
  rekomendasiCircle(@CurrentUser() user: AuthenticatedUser, @Query() query: RekomendasiQuery) {
    return this.rekomendasi.rekomendasi(user.id, query.limit);
  }

  @Get('saya')
  saya(@CurrentUser() user: AuthenticatedUser) {
    return this.circle.saya(user.id);
  }

  @Post()
  ajukan(@CurrentUser() user: AuthenticatedUser, @Body() dto: AjukanCircleDto) {
    return this.circle.ajukan(user.id, dto);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.circle.detail(user.id, id);
  }

  /** 201 bila baru bergabung, 200 bila sudah anggota (idempoten); 409 `CIRCLE_PENUH`. */
  @Post(':id/gabung')
  async gabung(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Res({ passthrough: true }) response: Response) {
    const hasil = await this.circle.gabung(user.id, id);
    response.status(hasil.baru ? HttpStatus.CREATED : HttpStatus.OK);
    return hasil;
  }

  @Post(':id/keluar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async keluar(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string): Promise<void> {
    await this.circle.keluar(user.id, id);
  }

  @Patch(':id/keanggotaan')
  ubahAnonim(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahKeanggotaanDto) {
    return this.circle.ubahAnonim(user.id, id, dto.status_anonim);
  }

  @Get(':id/pesan')
  daftarPesan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Query() query: DaftarPesanQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.circle.daftarPesan(user.id, id, query.sebelum, query.limit);
  }

  @Post(':id/pesan')
  kirimPesan(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: KirimPesanCircleDto) {
    return this.circle.kirimPesan(user.id, id, dto.isi);
  }
}

/** Preferensi minat mahasiswa untuk rekomendasi Circle (02-backend.md §8.1: `PUT /me/preferensi-minat`). */
@Controller('me/preferensi-minat')
@Roles(Role.MAHASISWA)
export class PreferensiMinatController {
  constructor(private readonly rekomendasi: RekomendasiService) {}

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser) {
    return this.rekomendasi.preferensi(user.id);
  }

  @Put()
  simpan(@CurrentUser() user: AuthenticatedUser, @Body() dto: PreferensiMinatDto) {
    return this.rekomendasi.simpanPreferensi(user.id, dto.id_kategori);
  }
}
