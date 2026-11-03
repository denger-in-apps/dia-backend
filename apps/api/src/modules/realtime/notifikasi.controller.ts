import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthenticatedUser } from '../../common/auth/auth.types';

export class DaftarNotifikasiQuery {
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  belum_dibaca?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Notifikasi in-app milik pengguna yang sedang login (semua role). Untuk psikolog,
 * ini cadangan bila koneksi realtime terputus saat SOS masuk.
 */
@Controller('notifikasi')
export class NotifikasiController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get()
  async daftar(@CurrentUser() user: AuthenticatedUser, @Query() query: DaftarNotifikasiQuery) {
    const result = await this.pool.query(
      `SELECT id_notifikasi::text AS id, jenis, payload, dibaca_at, created_at
       FROM notifikasi
       WHERE id_penerima = $1 AND role = $2 AND ($3::boolean IS NOT TRUE OR dibaca_at IS NULL)
       ORDER BY created_at DESC
       LIMIT $4`,
      [user.id, user.role, query.belum_dibaca ?? false, query.limit ?? 50],
    );
    return result.rows;
  }

  @Post(':id/dibaca')
  @HttpCode(HttpStatus.NO_CONTENT)
  async tandaiDibaca(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE notifikasi SET dibaca_at = COALESCE(dibaca_at, now())
       WHERE id_notifikasi = $1 AND id_penerima = $2 AND role = $3`,
      [id, user.id, user.role],
    );
    if (result.rowCount !== 1) {
      throw new NotFoundException({ kode: 'NOTIFIKASI_TIDAK_DITEMUKAN', pesan: 'Notifikasi tidak ditemukan' });
    }
  }
}
