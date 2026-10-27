import { UnauthorizedException } from '@nestjs/common';
import { StudentIdentity } from './oidc-sso.strategy';
export declare const SSO_STRATEGY: unique symbol;
export interface SsoStrategy {
    createAuthorizationUrl(): Promise<URL>;
    completeAuthorization(query: Record<string, unknown>): Promise<StudentIdentity>;
}
export declare class SsoProviderDeniedException extends UnauthorizedException {
    constructor();
}
