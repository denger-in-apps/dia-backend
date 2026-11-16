import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { TEKS_BEBAS } from '../booking/booking.dto';
import { KUOTA_MAKS, KUOTA_MIN } from './circle.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

export class TelusuriCircleQuery {
  @IsOptional()
  @IsUUID()
  kategori?: string;

  /** Cari nama/deskripsi (mengandung). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AjukanCircleDto {
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_circle mengandung karakter tidak valid' })
  nama_circle!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  @Matches(TEKS_BEBAS, { message: 'deskripsi mengandung karakter tidak valid' })
  deskripsi?: string;

  @IsUUID()
  id_kategori!: string;

  @IsOptional()
  @IsInt()
  @Min(KUOTA_MIN)
  @Max(KUOTA_MAKS)
  kuota?: number;
}

export class UbahKeanggotaanDto {
  /** `false` = tampilkan nama tampilan (bukan alias) ke anggota Circle ini. */
  @IsBoolean()
  status_anonim!: boolean;
}

export class KirimPesanCircleDto {
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Matches(TEKS_BEBAS, { message: 'isi mengandung karakter tidak valid' })
  isi!: string;
}

export class DaftarPesanQuery {
  /** Pesan sebelum id ini (paginasi mundur). */
  @IsOptional()
  @IsUUID()
  sebelum?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AlasanDto {
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  @MaxLength(500)
  @Matches(TEKS_BEBAS, { message: 'alasan mengandung karakter tidak valid' })
  alasan!: string;
}
