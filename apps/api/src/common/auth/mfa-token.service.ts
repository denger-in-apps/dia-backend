import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from './auth.types';

/** Audience berbeda dari access token: token pendaftaran MFA tidak dapat dipakai mengakses API. */
const AUDIENCE = 'dia-mfa-setup';
const TUJUAN = 'MFA_SETUP';
export const MFA_SETUP_TTL_DETIK = 600;

export type RoleStaf = Extract<AuthenticatedUser['role'], 'PSIKOLOG' | 'DOSEN_ADMIN'>;

/**
 * Token pendaftaran MFA (SCRUM-208): diterbitkan setelah password staf terbukti benar
 * (login saat MFA wajib) atau untuk staf yang sudah login dan ingin mengaktifkan MFA.
 */
@Injectable()
export class MfaTokenService {
  constructor(private readonly jwt: JwtService) {}

  terbitkan(user: { id: string; role: RoleStaf }): Promise<string> {
    return this.jwt.signAsync(
      { tujuan: TUJUAN, role: user.role },
      { subject: user.id, audience: AUDIENCE, expiresIn: MFA_SETUP_TTL_DETIK, jwtid: randomUUID() },
    );
  }

  async verifikasi(token: string): Promise<{ id: string; role: RoleStaf }> {
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; role: string; tujuan: string }>(token, {
        algorithms: ['RS256'],
        audience: AUDIENCE,
      });
      if (claims.tujuan === TUJUAN && claims.sub && (claims.role === 'PSIKOLOG' || claims.role === 'DOSEN_ADMIN')) {
        return { id: claims.sub, role: claims.role };
      }
    } catch {
      // diteruskan ke error di bawah
    }
    throw new UnauthorizedException({ kode: 'MFA_TOKEN_TIDAK_VALID', pesan: 'Token pendaftaran MFA tidak valid atau kedaluwarsa; login ulang' });
  }
}
