import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { TEKS_BEBAS } from '../booking/booking.dto';
import { KUOTA_MAKS, KUOTA_MIN } from './circle.constants';
import { NO_CONTROL_CHARS } from './circle.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const STATUS_CIRCLE = ['DIAJUKAN', 'AKTIF', 'DITOLAK', 'DITUTUP'] as const;

export class DaftarCircleAdminQuery {
  @IsOptional()
  @IsIn(STATUS_CIRCLE)
  status?: (typeof STATUS_CIRCLE)[number];
}

export class SetujuiCircleDto {
  /** Psikolog pendamping (wajib, CHECK `circle_aktif_butuh_pendamping`). */
  @IsUUID()
  id_psikolog!: string;
}

export class BuatCircleAdminDto {
  @Transform(trim) @IsString() @Length(3, 80)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_circle mengandung karakter tidak valid' })
  nama_circle!: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000)
  @Matches(TEKS_BEBAS, { message: 'deskripsi mengandung karakter tidak valid' })
  deskripsi?: string;

  @IsUUID()
  id_kategori!: string;

  @IsOptional() @IsInt() @Min(KUOTA_MIN) @Max(KUOTA_MAKS)
  kuota?: number;

  @IsUUID()
  id_psikolog!: string;
}

export class UbahCircleAdminDto {
  @IsOptional() @Transform(trim) @IsString() @Length(3, 80)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_circle mengandung karakter tidak valid' })
  nama_circle?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000)
  @Matches(TEKS_BEBAS, { message: 'deskripsi mengandung karakter tidak valid' })
  deskripsi?: string;

  @IsOptional() @IsUUID()
  id_kategori?: string;

  @IsOptional() @IsInt() @Min(KUOTA_MIN) @Max(KUOTA_MAKS)
  kuota?: number;

  /** Ganti pendamping (hanya untuk Circle AKTIF). */
  @IsOptional() @IsUUID()
  id_psikolog?: string;
}
