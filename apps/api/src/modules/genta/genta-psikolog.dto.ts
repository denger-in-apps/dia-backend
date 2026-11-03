import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

export const CAKUPAN_ANTREAN = ['aktif', 'antrean', 'milik_saya', 'riwayat'] as const;
export type CakupanAntrean = (typeof CAKUPAN_ANTREAN)[number];

export class DaftarSosQuery {
  /**
   * `aktif` (default): antrean belum diambil + kasus aktif milik saya.
   * `antrean`: hanya yang belum diambil. `milik_saya`: kasus aktif saya. `riwayat`: kasus saya yang selesai.
   */
  @IsOptional()
  @IsIn(CAKUPAN_ANTREAN)
  cakupan?: CakupanAntrean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UbahStatusSosDto {
  @IsIn(['DITANGANI', 'SELESAI'])
  status!: 'DITANGANI' | 'SELESAI';

  /** Catatan penanganan (disimpan terenkripsi). Wajib bila menandai laporan tidak valid. */
  @ValidateIf((dto: UbahStatusSosDto) => dto.catatan !== undefined || dto.laporan_tidak_valid === true)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'catatan wajib diisi saat menandai laporan tidak valid' })
  @Length(1, 2000)
  catatan?: string;

  /** Hanya bersama `SELESAI`: kasus dinilai bukan keadaan darurat (dipakai anti-penyalahgunaan PBI-05). */
  @IsOptional()
  @IsBoolean()
  laporan_tidak_valid?: boolean;
}
