export declare const USER_ROLES: readonly ["MAHASISWA", "PSIKOLOG", "DOSEN_ADMIN"];
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
