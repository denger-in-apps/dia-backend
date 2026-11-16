import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { TEKS_BEBAS } from '../booking/booking.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/** Nilai enum PostgreSQL `kategori_sumber`. */
export const KATEGORI_SUMBER = ['UNIT_KESEHATAN_KAMPUS', 'RUMAH_SAKIT_RUJUKAN', 'HOTLINE_NASIONAL', 'KOMUNITAS_SEBAYA'] as const;
export type KategoriSumber = (typeof KATEGORI_SUMBER)[number];

export class DaftarSumberDayaQuery {
  @IsOptional()
  @IsIn(KATEGORI_SUMBER)
  kategori?: KategoriSumber;
}

export class BuatSumberDayaDto {
  @Transform(trim) @IsString() @Length(2, 120)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama!: string;

  @IsIn(KATEGORI_SUMBER)
  kategori!: KategoriSumber;

  /** Nomor telepon, alamat, email, atau URL layanan (teks bebas satu baris). */
  @Transform(trim) @IsString() @Length(3, 200)
  @Matches(NO_CONTROL_CHARS, { message: 'kontak mengandung karakter tidak valid' })
  kontak!: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000)
  @Matches(TEKS_BEBAS, { message: 'deskripsi mengandung karakter tidak valid' })
  deskripsi?: string;

  @IsOptional() @IsBoolean()
  aktif?: boolean;
}

export class UbahSumberDayaDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama?: string;

  @IsOptional() @IsIn(KATEGORI_SUMBER)
  kategori?: KategoriSumber;

  @IsOptional() @Transform(trim) @IsString() @Length(3, 200)
  @Matches(NO_CONTROL_CHARS, { message: 'kontak mengandung karakter tidak valid' })
  kontak?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000)
  @Matches(TEKS_BEBAS, { message: 'deskripsi mengandung karakter tidak valid' })
  deskripsi?: string;

  @IsOptional() @IsBoolean()
  aktif?: boolean;
}
