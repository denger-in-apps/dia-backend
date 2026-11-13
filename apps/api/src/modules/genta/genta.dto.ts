
import { Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsJWT,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { KODE_SITUASI_SOS, SituasiSos } from './genta.constants';

/** Koordinat dari Browser Geolocation API (WGS84). */
export class LokasiDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng!: number;

  /** Radius akurasi dalam meter (GeolocationCoordinates.accuracy). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100_000)
  akurasi_m?: number;
}

export class BuatSosDto {
  /** Token dari `POST /genta/sos/konfirmasi`. */
  @IsString()
  @MaxLength(4096)
  @IsJWT()
  token_konfirmasi!: string;

  @IsIn(KODE_SITUASI_SOS)
  situasi!: SituasiSos;

  /** Pernyataan eksplisit pengguna bahwa ini keadaan darurat. */
  @Equals(true, { message: 'konfirmasi harus bernilai true' })
  konfirmasi!: true;

  /** Opsional: hanya dikirim bila mahasiswa memilih berbagi lokasi (FR-MHS-04). */
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => LokasiDto)
  lokasi?: LokasiDto;
}
