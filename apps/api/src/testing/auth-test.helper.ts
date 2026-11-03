import { Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { RolesGuard } from '../common/auth/roles.guard';
import { AuthenticatedUser, UserRole } from '../common/auth/auth.types';
import { DATABASE_POOL } from '../database/database.module';
import { AkademikService } from '../modules/akademik/akademik.service';

/** Akun uji tetap per role; dipakai sebagai `@CurrentUser()` di controller test. */
export const TEST_USERS: Record<UserRole, AuthenticatedUser> = {
  MAHASISWA: { id: '11111111-1111-4111-8111-111111111111', role: 'MAHASISWA' },
  PSIKOLOG: { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' },
  DOSEN_ADMIN: { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' },
};

export const bearer = (role: UserRole): string => `Bearer test-token-${role}`;

/**
 * Provider guard global (JwtAuthGuard + RolesGuard) persis seperti AuthModule,
 * dengan JWT & DB tiruan: token `test-token-<ROLE>` valid untuk akun aktif role itu.
 * Gunakan bila controller yang diuji tidak memakai DATABASE_POOL secara langsung.
 */
export function authGuardProviders(): Provider[] {
  const jwt = {
    verifyAsync: jest.fn(async (token: string) => {
      const user = TEST_USERS[token.replace(/^test-token-/, '') as UserRole];
      if (!user) throw new Error('invalid token');
      return { sub: user.id, role: user.role, jti: 'test-jti', iat: 1, exp: 9_999_999_999 };
    }),
  };
  const guardPool = {
    query: jest.fn().mockResolvedValue({
      rows: [{ nim: 'TEST-NIM', status_aktif: true, terakhir_verifikasi_at: new Date() }],
    }),
  };
  return [
    { provide: JwtService, useValue: jwt },
    { provide: DATABASE_POOL, useValue: guardPool },
    { provide: AkademikService, useValue: { wajibAktif: jest.fn() } },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ];
}
