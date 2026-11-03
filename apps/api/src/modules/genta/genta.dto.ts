import { Equals, IsIn, IsJWT, IsString, MaxLength } from 'class-validator';
import { KODE_SITUASI_SOS, SituasiSos } from './genta.constants';

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
}
