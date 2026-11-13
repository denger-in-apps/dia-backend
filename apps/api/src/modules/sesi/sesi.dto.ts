import { Transform, Type } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TEKS_BEBAS, WAKTU_ISO } from '../booking/booking.dto';

/** Batas ukuran (karakter base64) agar satu pesan/kunci tidak membebani DB atau socket. */
export const MAKS_CIPHERTEXT_B64 = 22_000; // ≈ 16 KiB biner
export const MAKS_KUNCI_B64 = 1_400; // ≈ 1 KiB DER

export class SimpanKunciDto {
  /** Kunci publik SPKI DER (base64): EC P-256 atau X25519, mis. hasil `crypto.subtle.exportKey('spki', ...)`. */
  @IsString()
  @MaxLength(MAKS_KUNCI_B64)
  @IsBase64()
  kunci_publik!: string;
}

export class KirimPesanDto {
  /** Ciphertext (base64) hasil enkripsi di perangkat; server tidak pernah melihat plaintext. */
  @IsString()
  @MaxLength(MAKS_CIPHERTEXT_B64)
  @IsBase64()
  ciphertext!: string;

  /** Nonce/IV (base64), 12–32 byte. */
  @IsString()
  @MaxLength(64)
  @IsBase64()
  nonce!: string;
}

export class DaftarPesanQuery {
  /** Ambil pesan setelah waktu ini (ISO-8601 berzona) untuk sinkronisasi bertahap. */
  @IsOptional()
  @Matches(WAKTU_ISO, { message: 'setelah harus ISO-8601 dengan zona waktu' })
  setelah?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export const CAKUPAN_SESI_PSIKOLOG = ['mendatang', 'riwayat', 'semua'] as const;
export type CakupanSesiPsikolog = (typeof CAKUPAN_SESI_PSIKOLOG)[number];

export class DaftarSesiPsikologQuery {
  @IsOptional()
  @IsIn(CAKUPAN_SESI_PSIKOLOG)
  cakupan?: CakupanSesiPsikolog;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export const STATUS_UBAH_PSIKOLOG = ['BERLANGSUNG', 'SELESAI', 'TIDAK_HADIR'] as const;

export class UbahStatusSesiDto {
  @IsIn(STATUS_UBAH_PSIKOLOG)
  status!: (typeof STATUS_UBAH_PSIKOLOG)[number];
}

export class ConsentCatatanDto {
  /** `true` = setuju psikolog mencatat ringkasan; `false` = tarik consent (ringkasan dihapus). */
  @IsBoolean()
  setuju!: boolean;
}

export class SimpanRingkasanDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 5000)
  @Matches(TEKS_BEBAS, { message: 'ringkasan mengandung karakter tidak valid' })
  ringkasan!: string;
}

export class RiwayatQuery {
  /** Kosong = daftar mahasiswa dampingan; diisi = riwayat sesi mahasiswa tersebut. */
  @IsOptional()
  @IsUUID()
  mahasiswa?: string;
}
