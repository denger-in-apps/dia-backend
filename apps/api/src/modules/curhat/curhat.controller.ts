import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { DaftarQuery, KirimCurhatDto } from './curhat.dto';
import { CurhatService } from './curhat.service';

/** Ruang curhat anonim — mahasiswa (PBI-16 / SCRUM-260, FR-MHS-09). */
@Controller('curhat')
@Roles(Role.MAHASISWA)
export class CurhatController {
  constructor(private readonly curhat: CurhatService) {}

  @Post()
  kirim(@CurrentUser() user: AuthenticatedUser, @Body() dto: KirimCurhatDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.curhat.kirim(user.id, dto.isi);
  }

  @Get()
  daftar(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarQuery, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.curhat.daftar(user.id, query.limit);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.curhat.detail(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hapus(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.curhat.hapus(user.id, id);
  }
}
