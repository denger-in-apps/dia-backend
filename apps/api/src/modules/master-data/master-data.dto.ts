import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

// ---- Kategori minat ---------------------------------------------------------

export class KategoriMinatDto {
  @Transform(trim) @IsString() @Length(2, 60)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama!: string;
}

export class UbahKategoriMinatDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 60)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama?: string;

  @IsOptional() @IsBoolean()
  aktif?: boolean;
}

// ---- Template kuesioner -----------------------------------------------------

export const KODE_KUESIONER = ['PHQ9', 'GAD7'] as const;

export class ButirKuesionerDto {
  @IsInt() @Min(1) @Max(20)
  no!: number;

  @Transform(trim) @IsString() @Length(3, 300)
  @Matches(NO_CONTROL_CHARS, { message: 'teks butir mengandung karakter tidak valid' })
  teks!: string;
}

export class OpsiKuesionerDto {
  @IsInt() @Min(0) @Max(3)
  nilai!: number;

  @Transform(trim) @IsString() @Length(1, 60)
  @Matches(NO_CONTROL_CHARS, { message: 'label opsi mengandung karakter tidak valid' })
  label!: string;
}

export class IsiTemplateDto {
  @Transform(trim) @IsString() @Length(1, 300)
  @Matches(NO_CONTROL_CHARS, { message: 'pertanyaan_pembuka mengandung karakter tidak valid' })
  pertanyaan_pembuka!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => ButirKuesionerDto)
  butir!: ButirKuesionerDto[];

  @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4)
  @ValidateNested({ each: true }) @Type(() => OpsiKuesionerDto)
  opsi!: OpsiKuesionerDto[];
}

/** Versi baru sebuah kuesioner. Template tidak dapat diubah setelah dibuat (versi baru = revisi). */
export class BuatTemplateDto {
  @IsIn(KODE_KUESIONER)
  kode!: (typeof KODE_KUESIONER)[number];

  @Transform(trim) @IsString() @Length(3, 120)
  @Matches(NO_CONTROL_CHARS, { message: 'nama mengandung karakter tidak valid' })
  nama!: string;

  @ValidateNested() @Type(() => IsiTemplateDto)
  butir!: IsiTemplateDto;
}

export class DaftarTemplateQuery {
  @IsOptional() @IsIn(KODE_KUESIONER)
  kode?: (typeof KODE_KUESIONER)[number];
}
