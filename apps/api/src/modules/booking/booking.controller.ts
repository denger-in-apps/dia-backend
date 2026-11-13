import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { BookingService } from './booking.service';
import { BuatBookingDto, DaftarBookingQuery, SlotQuery } from './booking.dto';

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
