export const USER_ROLES = ['MAHASISWA', 'PSIKOLOG', 'DOSEN_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  jti: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface AuthProfile extends AuthenticatedUser {
  nama: string;
  email: string;
}

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
  refreshToken: string;
  refreshTokenExpiresIn: number;
}
