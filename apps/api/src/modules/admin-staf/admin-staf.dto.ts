import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const TANGGAL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const JAM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Jam selesai boleh 24:00 (akhir hari) agar shift sampai tengah malam tidak berlubang 1 menit. */
const JAM_SELESAI = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export const STATUS_AKUN_STAF = ['MENUNGGU_VERIFIKASI', 'AKTIF', 'NONAKTIF'] as const;

export class DaftarPsikologQuery {
  @IsOptional() @IsIn(STATUS_AKUN_STAF)
  status?: (typeof STATUS_AKUN_STAF)[number];

  /** Cari nama/email (mengandung). */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100)
  q?: string;
}

export class BuatPsikologDto {
  @Transform(trim) @IsString() @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama!: string;

  @Transform(lower) @IsEmail() @MaxLength(254)
  email!: string;
}

export class UbahPsikologDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama?: string;

  @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254)
  email?: string;
}

export class DaftarJadwalQuery {
  @IsOptional() @Matches(TANGGAL, { message: 'dari harus YYYY-MM-DD' })
  dari?: string;

  @IsOptional() @Matches(TANGGAL, { message: 'sampai harus YYYY-MM-DD' })
  sampai?: string;

  @IsOptional() @IsUUID()
  id_psikolog?: string;
}

export class BuatJadwalDto {
  @IsUUID()
  id_psikolog!: string;

  @Matches(TANGGAL, { message: 'tanggal harus YYYY-MM-DD' })
  tanggal!: string;

  @Matches(JAM, { message: 'jam_mulai harus HH:MM' })
  jam_mulai!: string;

  @Matches(JAM_SELESAI, { message: 'jam_selesai harus HH:MM (boleh 24:00)' })
  jam_selesai!: string;
}

export class UbahJadwalDto {
  @IsOptional() @IsUUID()
  id_psikolog?: string;

  @IsOptional() @Matches(TANGGAL, { message: 'tanggal harus YYYY-MM-DD' })
  tanggal?: string;

  @IsOptional() @Matches(JAM, { message: 'jam_mulai harus HH:MM' })
  jam_mulai?: string;

  @IsOptional() @Matches(JAM_SELESAI, { message: 'jam_selesai harus HH:MM (boleh 24:00)' })
  jam_selesai?: string;
}
