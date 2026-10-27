import { StudentIdentity } from './oidc-sso.strategy';
export declare const SSO_STRATEGY: unique symbol;
export interface SsoStrategy {
    createAuthorizationUrl(): Promise<URL>;
    completeAuthorization(query: Record<string, unknown>): Promise<StudentIdentity>;
}
