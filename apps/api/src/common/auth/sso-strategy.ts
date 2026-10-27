import { StudentIdentity } from './oidc-sso.strategy';

export const SSO_STRATEGY = Symbol('SSO_STRATEGY');

export interface SsoStrategy {
  createAuthorizationUrl(): Promise<URL>;
  completeAuthorization(query: Record<string, unknown>): Promise<StudentIdentity>;
}
