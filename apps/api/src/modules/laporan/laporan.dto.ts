import { IsOptional, Matches } from 'class-validator';

const BULAN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Rentang bulan inklusif `YYYY-MM`. Default 12 bulan terakhir; maks. 36 bulan. */
export class PeriodeQuery {
  @IsOptional()
  @Matches(BULAN, { message: 'dari harus YYYY-MM' })
  dari?: string;

  @IsOptional()
  @Matches(BULAN, { message: 'sampai harus YYYY-MM' })
  sampai?: string;
}
