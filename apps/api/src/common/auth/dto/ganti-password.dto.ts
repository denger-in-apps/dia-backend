import { IsString, Length } from 'class-validator';

export class GantiPasswordDto {
  @IsString()
  @Length(1, 256)
  password_lama!: string;

  @IsString()
  @Length(12, 256, { message: 'password_baru minimal 12 karakter' })
  password_baru!: string;
}
