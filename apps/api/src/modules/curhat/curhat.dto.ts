import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { TEKS_BEBAS } from '../booking/booking.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class KirimCurhatDto {
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  @Matches(TEKS_BEBAS, { message: 'isi mengandung karakter tidak valid' })
  isi!: string;
}

export class DaftarQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export const STATUS_CURHAT = ['BARU', 'DIBACA', 'DIJAWAB'] as const;
export type StatusCurhat = (typeof STATUS_CURHAT)[number];

export class DaftarCurhatPsikologQuery extends DaftarQuery {
  @IsOptional()
  @IsIn(STATUS_CURHAT)
  status?: StatusCurhat;
}

export class BalasCurhatDto {
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  @Matches(TEKS_BEBAS, { message: 'isi mengandung karakter tidak valid' })
  isi!: string;
}
