import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { UserRole } from '../auth.types';

export class StaffLoginDto {
  @IsIn(['PSIKOLOG', 'DOSEN_ADMIN'])
  role!: Extract<UserRole, 'PSIKOLOG' | 'DOSEN_ADMIN'>;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 256)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  otp?: string;
}
