import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalizePhone = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value;
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const PHONE = /^\+?[0-9]{8,15}$/;

/** Semua field opsional: hanya field yang dikirim yang diubah. Rentang sama dengan CHECK DB. */
export class UbahKonfigurasiSosDto {
  @IsOptional() @IsInt() @Min(30) @Max(1800)
  durasi_eskalasi_detik?: number;

  @IsOptional() @IsBoolean()
  eskalasi_segera_jika_tidak_ada_psikolog?: boolean;

  @IsOptional() @Transform(trim) @IsString() @Length(3, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'hotline_label mengandung karakter tidak valid' })
  hotline_label?: string;

  @IsOptional() @IsBoolean()
  hotline_aktif?: boolean;

  @IsOptional() @IsBoolean()
  kontak_darurat_aktif?: boolean;

  @IsOptional() @IsBoolean()
  kontak_darurat_untuk_perlu_verifikasi?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(10)
  maks_eskalasi_kontak_per_hari?: number;

  /** Tidak bisa 0: admin tidak boleh mematikan tombol SOS. */
  @IsOptional() @IsInt() @Min(1) @Max(60)
  sos_maks_per_jam?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  sos_ambang_iseng_30_hari?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  sos_ambang_batal_24_jam?: number;
}

export class BuatPenerimaEskalasiDto {
  @Transform(trim) @IsString() @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama!: string;

  @Transform(normalizePhone) @IsString()
  @Matches(PHONE, { message: 'no_telepon harus 8–15 digit, boleh diawali +' })
  no_telepon!: string;

  @IsOptional() @IsBoolean()
  aktif?: boolean;
}

export class UbahPenerimaEskalasiDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama?: string;

  @IsOptional() @Transform(normalizePhone) @IsString()
  @Matches(PHONE, { message: 'no_telepon harus 8–15 digit, boleh diawali +' })
  no_telepon?: string;

  @IsOptional() @IsBoolean()
  aktif?: boolean;
}
