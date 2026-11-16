import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { NILAI_MAKS_BUTIR } from './skor';

/**
 * Kirim jawaban. Minimal salah satu kuesioner; setiap kuesioner butuh pasangan
 * `id_template_*` + `jawaban_*` (dicek di service bersama jumlah butir template).
 * Skor TIDAK diterima dari klien (dihitung server, 02-backend.md §9.1).
 */
export class KirimCekMandiriDto {
  @IsOptional()
  @IsUUID()
  id_template_phq9?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(NILAI_MAKS_BUTIR, { each: true })
  jawaban_phq9?: number[];

  @IsOptional()
  @IsUUID()
  id_template_gad7?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(NILAI_MAKS_BUTIR, { each: true })
  jawaban_gad7?: number[];
}

export class RiwayatCekQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
