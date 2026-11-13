import { IsJWT, IsString, Length, Matches, MaxLength } from 'class-validator';

export class MulaiMfaDto {
  @IsString()
  @MaxLength(4096)
  @IsJWT()
  mfa_setup_token!: string;
}

export class AktifkanMfaDto extends MulaiMfaDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'otp harus 6 digit' })
  otp!: string;
}
