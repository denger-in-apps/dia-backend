import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenClaims, USER_ROLES } from './auth.types';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AkademikService } from '../../modules/akademik/akademik.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly akademik: AkademikService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new UnauthorizedException('Token tidak valid');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenClaims>(match[1], {
        algorithms: ['RS256'],
      });
    } catch {
      throw new UnauthorizedException('Token tidak valid atau sudah kedaluwarsa');
    }

    if (
      !claims.sub ||
      !claims.jti ||
      !USER_ROLES.includes(claims.role) ||
      !claims.iat ||
      !claims.exp
    ) throw new UnauthorizedException('Token tidak valid atau sudah kedaluwarsa');

    if (claims.role === 'MAHASISWA') {
      const result = await this.pool.query<{
        nim: string;
        status_aktif: boolean;
        terakhir_verifikasi_at: Date | null;
      }>(
        `SELECT nim, status_aktif, terakhir_verifikasi_at FROM mahasiswa
         WHERE id_mahasiswa = $1 AND deleted_at IS NULL`,
        [claims.sub],
      );
      const student = result.rows[0];
      if (!student?.status_aktif) throw new ForbiddenException('AKUN_TIDAK_AKTIF');
      if (!student.terakhir_verifikasi_at ||
          Date.now() - new Date(student.terakhir_verifikasi_at).getTime() >= 24 * 60 * 60 * 1000) {
        await this.akademik.wajibAktif(student.nim);
      }
    }

    request.user = { id: claims.sub, role: claims.role };
    return true;
  }
}
