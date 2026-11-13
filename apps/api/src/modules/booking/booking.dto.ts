import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { TIPE_SESI, TipeSesi } from '../../common/domain/sesi';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Teks bebas boleh berisi baris baru/tab, tetapi tidak karakter kontrol lain. */
export const TEKS_BEBAS = /^(?:[^\p{Cc}]|[\n\r\t])*$/u;
/** ISO-8601 dengan zona eksplisit agar tidak ditafsirkan memakai zona server. */
export const WAKTU_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const TANGGAL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class SlotQuery {
  @Matches(TANGGAL, { message: 'tanggal harus YYYY-MM-DD' })
  tanggal!: string;
}

export class BuatBookingDto {
  @IsUUID()
  id_psikolog!: string;

  /** Waktu mulai slot, mis. `2026-12-01T09:00:00+07:00`. Harus tepat salah satu slot `GET /psikolog/:id/slot`. */
  @Matches(WAKTU_ISO, { message: 'waktu_mulai harus ISO-8601 dengan zona waktu, mis. 2026-12-01T09:00:00+07:00' })
  waktu_mulai!: string;

  @IsIn(TIPE_SESI)
  tipe_sesi!: TipeSesi;

  /** Keluhan awal (disimpan terenkripsi; hanya mahasiswa & psikolog sesi yang dapat membaca). */
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Matches(TEKS_BEBAS, { message: 'keluhan_awal mengandung karakter tidak valid' })
  keluhan_awal!: string;
}

export const CAKUPAN_BOOKING = ['mendatang', 'riwayat', 'semua'] as const;
export type CakupanBooking = (typeof CAKUPAN_BOOKING)[number];

export class DaftarBookingQuery {
  /** `mendatang` (default): DIJADWALKAN/BERLANGSUNG; `riwayat`: SELESAI/DIBATALKAN/TIDAK_HADIR. */
  @IsOptional()
  @IsIn(CAKUPAN_BOOKING)
  cakupan?: CakupanBooking;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
