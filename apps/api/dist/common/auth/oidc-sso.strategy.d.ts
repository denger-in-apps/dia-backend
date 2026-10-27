import Redis from 'ioredis';
import { SsoStrategy } from './sso-strategy';
export interface StudentIdentity {
    subject: string;
    nim: string;
    email: string;
    name: string;
}
export declare class OidcSsoStrategy implements SsoStrategy {
    private readonly redis;
    private configuration?;
    constructor(redis: Redis);
    createAuthorizationUrl(): Promise<URL>;
    completeAuthorization(query: Record<string, unknown>): Promise<StudentIdentity>;
    private getConfiguration;
    private ensureRedisConnection;
    private requiredEnv;
    private stateKey;
}
