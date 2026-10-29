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
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly akademik: AkademikService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

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

    const accountQuery = claims.role === 'MAHASISWA'
      ? `SELECT nim, status_aktif, terakhir_verifikasi_at FROM mahasiswa
         WHERE id_mahasiswa = $1 AND deleted_at IS NULL`
      : claims.role === 'PSIKOLOG'
        ? `SELECT NULL::text AS nim, true AS status_aktif, NULL::timestamptz AS terakhir_verifikasi_at
           FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`
        : `SELECT NULL::text AS nim, true AS status_aktif, NULL::timestamptz AS terakhir_verifikasi_at
           FROM dosen_admin WHERE id_dosen = $1 AND aktif`;
    const result = await this.pool.query<{
        nim: string;
        status_aktif: boolean;
        terakhir_verifikasi_at: Date | null;
      }>(accountQuery, [claims.sub]);
    const account = result.rows[0];
    if (!account?.status_aktif) throw new ForbiddenException('AKUN_TIDAK_AKTIF');

    if (claims.role === 'MAHASISWA') {
      const student = account;
      if (!student.terakhir_verifikasi_at ||
          Date.now() - new Date(student.terakhir_verifikasi_at).getTime() >= 24 * 60 * 60 * 1000) {
        await this.akademik.wajibAktif(student.nim);
      }
    }

    request.user = { id: claims.sub, role: claims.role };
    return true;
  }
}
