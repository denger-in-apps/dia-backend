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
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import {
  ConsentCatatanDto,
  DaftarPesanQuery,
  DaftarSesiPsikologQuery,
  KirimPesanDto,
  RiwayatQuery,
  SimpanKunciDto,
  SimpanRingkasanDto,
  UbahStatusSesiDto,
} from './sesi.dto';
import { RingkasanService } from './ringkasan.service';
import { RuangSesiService } from './ruang-sesi.service';
import { SesiGateway } from './sesi.gateway';
import { KonteksPermintaan, SesiPsikologService } from './sesi-psikolog.service';

const uuid = () => new ParseUUIDPipe();
const konteks = (request: Request): KonteksPermintaan => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Kunci publik E2EE milik pengguna (02-backend.md §8.1: `POST /me/kunci-e2ee`). */
@Controller('me/kunci-e2ee')
@Roles(Role.MAHASISWA, Role.PSIKOLOG)
export class KunciE2eeController {
  constructor(private readonly ruang: RuangSesiService) {}

  @Get()
  kunciSaya(@CurrentUser() user: AuthenticatedUser) {
    return this.ruang.kunciSaya(user);
  }

  /** Unggah/ganti kunci publik (upsert). Mengganti kunci membuat pesan lama tak terbaca di perangkat baru. */
  @Put()
  simpan(@CurrentUser() user: AuthenticatedUser, @Body() dto: SimpanKunciDto) {
    return this.ruang.simpanKunci(user, dto.kunci_publik);
  }

  /** Alias sesuai katalog 02-backend.md §8.1. */
  @Post()
  simpanPost(@CurrentUser() user: AuthenticatedUser, @Body() dto: SimpanKunciDto) {
    return this.ruang.simpanKunci(user, dto.kunci_publik);
  }
}

/** Ruang sesi (dua peserta): kunci lawan bicara & riwayat ciphertext (PBI-11). */
@Controller('sesi')
@Roles(Role.MAHASISWA, Role.PSIKOLOG)
export class RuangSesiController {
  constructor(
    private readonly ruang: RuangSesiService,
    private readonly gateway: SesiGateway,
  ) {}

  @Get(':id/kunci')
  kunciLawan(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.ruang.kunciLawan(user, id);
  }

  @Get(':id/pesan')
  daftarPesan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Query() query: DaftarPesanQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.ruang.daftarPesan(user, id, query.setelah, query.limit);
  }

  /** Fallback HTTP untuk mengirim pesan bila socket tidak tersedia; tetap disiarkan ke room. */
  @Post(':id/pesan')
  async kirimPesan(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: KirimPesanDto) {
    const pesan = await this.ruang.kirimPesan(user, id, dto.ciphertext, dto.nonce);
    this.gateway.siarkanPesan(id, pesan);
    return pesan;
  }
}

/** Jadwal & pelaksanaan sesi oleh psikolog (PBI-11, FR-PSI-04). */
@Controller('psikolog/sesi')
@Roles(Role.PSIKOLOG)
export class SesiPsikologController {
  constructor(
    private readonly sesi: SesiPsikologService,
    private readonly gateway: SesiGateway,
    private readonly ringkasan: RingkasanService,
  ) {}

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarSesiPsikologQuery) {
    return this.sesi.daftar(user, query);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sesi.detail(user, id, konteks(request));
  }

  /** `BERLANGSUNG` (mulai) · `SELESAI` · `TIDAK_HADIR`. */
  @Patch(':id/status')
  async ubahStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Body() dto: UbahStatusSesiDto,
    @Req() request: Request,
  ) {
    const hasil = await this.sesi.ubahStatus(user, id, dto, konteks(request));
    this.gateway.siarkanStatus(id, { id_sesi: hasil.id_sesi, status_sesi: hasil.status_sesi });
    return hasil;
  }

  /** Tulis/perbarui ringkasan sesi (PBI-13); `403 CONSENT_BELUM_ADA` tanpa persetujuan mahasiswa. */
  @Put(':id/ringkasan')
  simpanRingkasan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Body() dto: SimpanRingkasanDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.ringkasan.simpan(user, id, dto.ringkasan, konteks(request));
  }

  @Get(':id/ringkasan')
  bacaRingkasan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.ringkasan.baca(user, id, konteks(request));
  }
}

/** Riwayat sesi mahasiswa dampingan (PBI-13, FR-PSI-08). */
@Controller('psikolog/riwayat')
@Roles(Role.PSIKOLOG)
export class RiwayatPsikologController {
  constructor(private readonly ringkasan: RingkasanService) {}

  /** Tanpa `mahasiswa`: daftar mahasiswa yang pernah ditangani. Dengan `mahasiswa=<id>`: riwayat sesinya. */
  @Get()
  riwayat(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RiwayatQuery,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return query.mahasiswa
      ? this.ringkasan.riwayatMahasiswa(user, query.mahasiswa, konteks(request))
      : this.ringkasan.daftarDampingan(user);
  }
}

/** Consent pencatatan ringkasan oleh mahasiswa (02-backend.md §8.4: `POST /booking/:id/consent-catatan`). */
@Controller('booking')
@Roles(Role.MAHASISWA)
export class ConsentCatatanController {
  constructor(private readonly ringkasan: RingkasanService) {}

  @Post(':id/consent-catatan')
  @HttpCode(HttpStatus.OK)
  aturConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid()) id: string,
    @Body() dto: ConsentCatatanDto,
    @Req() request: Request,
  ) {
    return this.ringkasan.aturConsent(user, id, dto.setuju, konteks(request));
  }
}
