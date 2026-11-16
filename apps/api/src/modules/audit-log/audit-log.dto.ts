import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { USER_ROLES } from '../../common/auth/auth.types';

/** Tanggal `YYYY-MM-DD` atau waktu ISO-8601 berzona. */
const WAKTU = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class FilterAuditLogQuery {
  /** id aktor (uuid). */
  @IsOptional() @IsUUID()
  aktor?: string;

  @IsOptional() @IsIn(USER_ROLES)
  aktor_role?: (typeof USER_ROLES)[number];

  /** Satu atau beberapa kode aksi dipisah koma, mis. `SOS_LOKASI_READ,CURHAT_READ`. */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500)
  @Matches(/^[A-Z0-9_]+(,[A-Z0-9_]+)*$/, { message: 'aksi harus kode huruf besar dipisah koma' })
  aksi?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 60)
  @Matches(/^[a-z0-9_]+$/, { message: 'resource_type tidak valid' })
  resource_type?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 300)
  resource_id?: string;

  @IsOptional() @IsIn(['SUKSES', 'DITOLAK'])
  hasil?: 'SUKSES' | 'DITOLAK';

  /** Batas bawah inklusif. */
  @IsOptional() @Matches(WAKTU, { message: 'dari harus YYYY-MM-DD atau ISO-8601 berzona' })
  dari?: string;

  /** Batas atas: tanggal saja = sampai akhir hari itu (UTC). */
  @IsOptional() @Matches(WAKTU, { message: 'sampai harus YYYY-MM-DD atau ISO-8601 berzona' })
  sampai?: string;
}

export class DaftarAuditLogQuery extends FilterAuditLogQuery {
  /** Kursor: ambil entri dengan `id_log` lebih kecil (lebih lama) dari ini. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  sebelum?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}
