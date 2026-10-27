import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SsoStrategy } from './sso-strategy';
import { AuthenticatedUser, AuthProfile } from './auth.types';
export declare class AuthController {
    private readonly auth;
    private readonly sso;
    constructor(auth: AuthService, sso: SsoStrategy);
    ssoLogin(response: Response): Promise<void>;
    ssoCallback(request: Request, response: Response): Promise<void>;
    staffLogin(body: unknown, request: Request, response: Response): Promise<void>;
    refresh(request: Request, response: Response): Promise<void>;
    logout(request: Request, response: Response): Promise<void>;
    me(user: AuthenticatedUser): Promise<AuthProfile>;
    private setRefreshCookie;
    private refreshCookieOptions;
    private publicSession;
    private assertTrustedOrigin;
    private frontendUrl;
}
