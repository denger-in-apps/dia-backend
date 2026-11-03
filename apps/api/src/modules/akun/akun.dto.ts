import { Transform } from 'class-transformer';
import { Equals, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Buang spasi, tanda hubung, titik, dan kurung dari nomor telepon sebelum divalidasi. */
const normalizePhone = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value;

const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const PHONE = /^\+?[0-9]{8,15}$/;

export class UpdateProfilDto {
  /** `null` mengosongkan nama tampilan (kembali memakai nama dari SSO). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_tampilan mengandung karakter tidak valid' })
  nama_tampilan?: string | null;
}

export class CreateKontakDaruratDto {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_kontak mengandung karakter tidak valid' })
  nama_kontak!: string;

  @Transform(normalizePhone)
  @IsString()
  @Matches(PHONE, { message: 'no_telepon harus 8–15 digit, boleh diawali +' })
  no_telepon!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  @Matches(NO_CONTROL_CHARS, { message: 'hubungan mengandung karakter tidak valid' })
  hubungan?: string;
}

export class UpdateKontakDaruratDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @Matches(NO_CONTROL_CHARS, { message: 'nama_kontak mengandung karakter tidak valid' })
  nama_kontak?: string;

  @IsOptional()
  @Transform(normalizePhone)
  @IsString()
  @Matches(PHONE, { message: 'no_telepon harus 8–15 digit, boleh diawali +' })
  no_telepon?: string;

  /** `null` menghapus keterangan hubungan. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  @Matches(NO_CONTROL_CHARS, { message: 'hubungan mengandung karakter tidak valid' })
  hubungan?: string | null;
}

export class HapusAkunDto {
  /** Konfirmasi eksplisit agar penghapusan tidak terjadi karena salah klik. */
  @Equals('HAPUS', { message: 'konfirmasi harus bernilai "HAPUS"' })
  konfirmasi!: 'HAPUS';
}
