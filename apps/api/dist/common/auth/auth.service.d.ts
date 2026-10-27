import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { EncryptionService } from '../crypto/encryption.service';
import { AuthProfile, AuthSession, AuthenticatedUser, UserRole } from './auth.types';
import { StudentIdentity } from './oidc-sso.strategy';
export declare class AuthService {
    private readonly pool;
    private readonly jwt;
    private readonly encryption;
    constructor(pool: Pool, jwt: JwtService, encryption: EncryptionService);
    loginStaff(role: Extract<UserRole, 'PSIKOLOG' | 'DOSEN_ADMIN'>, email: string, password: string, otp: string | undefined, ip: string | undefined, userAgent: string | undefined): Promise<AuthSession>;
    loginStudent(identity: StudentIdentity, ip: string | undefined, userAgent: string | undefined): Promise<AuthSession>;
    refresh(rawToken: string, ip: string | undefined, userAgent: string | undefined): Promise<AuthSession>;
    logout(rawToken: string | undefined): Promise<void>;
    getCurrentUser(user: AuthenticatedUser): Promise<AuthProfile | null>;
    private issueSession;
    private createSessionInTransaction;
    private isAccountActive;
    private verifyTotp;
    private hashToken;
    private refreshTokenTtlSeconds;
}
