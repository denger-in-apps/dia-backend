import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AkademikService } from '../../modules/akademik/akademik.service';
import { AccessTokenClaims, AuthenticatedUser, USER_ROLES } from './auth.types';

export interface VerifiedAccessToken {
  user: AuthenticatedUser;
  /** Waktu kedaluwarsa token (epoch detik). */
  exp: number;
}

/**
 * Verifikasi access token + status akun terkini. Dipakai bersama oleh
 * `JwtAuthGuard` (HTTP) dan gateway WebSocket agar aturan autentikasinya identik.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly akademik: AkademikService,
  ) {}

  async verifikasi(token: string): Promise<VerifiedAccessToken> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenClaims>(token, {
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
      if (!account.terakhir_verifikasi_at ||
          Date.now() - new Date(account.terakhir_verifikasi_at).getTime() >= 24 * 60 * 60 * 1000) {
        await this.akademik.wajibAktif(account.nim);
      }
    }

    return { user: { id: claims.sub, role: claims.role }, exp: claims.exp };
  }
}
