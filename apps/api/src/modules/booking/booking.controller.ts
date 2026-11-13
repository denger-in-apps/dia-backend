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
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BookingService } from './booking.service';
import { BatalBookingDto, BuatBookingDto, DaftarBookingQuery, SlotQuery, UbahJadwalBookingDto } from './booking.dto';

const uuid = () => new ParseUUIDPipe();

/** Booking konseling milik mahasiswa (PBI-10, FR-MHS-05). */
@Controller('booking')
@Roles(Role.MAHASISWA)
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  /** 201 bila berhasil; 409 `SESI_BENTROK` + `detail.alternatif[]` bila slot sudah dipesan. */
  @Post()
  buat(@CurrentUser() user: AuthenticatedUser, @Body() dto: BuatBookingDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.booking.buat(user.id, dto);
  }

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarBookingQuery) {
    return this.booking.daftar(user.id, query);
  }

  /** Ubah jadwal ke slot lain psikolog yang sama; 409 `SESI_BENTROK` + alternatif bila slot terisi. */
  @Patch(':id/jadwal')
  ubahJadwal(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UbahJadwalBookingDto) {
    return this.booking.ubahJadwal(user.id, id, dto);
  }

  @Post(':id/batal')
  @HttpCode(HttpStatus.OK)
  batal(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: BatalBookingDto) {
    return this.booking.batal(user.id, id, dto);
  }

  /** Detail memuat keluhan awal yang didekripsi; jangan di-cache. */
  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.booking.detail(user.id, id);
  }
}

/** Direktori psikolog & slot untuk dipesan mahasiswa (02-backend.md §8.4). */
@Controller('psikolog')
@Roles(Role.MAHASISWA)
export class DirektoriPsikologController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  daftar() {
    return this.booking.daftarPsikolog();
  }

  @Get(':id/slot')
  slot(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Query() query: SlotQuery) {
    return this.booking.slot(user.id, id, query.tanggal);
  }
}
