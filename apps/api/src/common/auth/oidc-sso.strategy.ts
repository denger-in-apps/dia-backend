import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as oidc from 'openid-client';
import Redis from 'ioredis';
import { AUTH_REDIS } from './sso-state.lifecycle';
import { SsoProviderDeniedException, SsoStrategy } from './sso-strategy';
import { Inject } from '@nestjs/common';

interface OidcLoginState {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
}

export interface StudentIdentity {
  subject: string;
  nim: string;
  email: string;
  name: string;
}

@Injectable()
export class OidcSsoStrategy implements SsoStrategy {
  private configuration?: Promise<oidc.Configuration>;

  constructor(@Inject(AUTH_REDIS) private readonly redis: Redis) {}

  async createAuthorizationUrl(): Promise<URL> {
    const config = await this.getConfiguration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const payload: OidcLoginState = { state, nonce, codeVerifier, issuedAt: Date.now() };

    await this.ensureRedisConnection();
    const saved = await this.redis.set(
      this.stateKey(state),
      JSON.stringify(payload),
      'EX',
      600,
      'NX',
    );
    if (saved !== 'OK') throw new ServiceUnavailableException('Gagal memulai login SSO');

    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.requiredEnv('OIDC_REDIRECT_URI'),
      response_type: 'code',
      scope: process.env.OIDC_SCOPES || 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async completeAuthorization(query: Record<string, unknown>): Promise<StudentIdentity> {
    const state = typeof query.state === 'string' ? query.state : '';
    if (!state || !/^[A-Za-z0-9_-]{20,256}$/.test(state)) {
      throw new UnauthorizedException('Respons SSO tidak valid');
    }

    await this.ensureRedisConnection();
    const stored = await this.redis.call('GETDEL', this.stateKey(state));
    if (typeof stored !== 'string') throw new UnauthorizedException('Sesi SSO kedaluwarsa atau sudah digunakan');

    let loginState: OidcLoginState;
    try {
      loginState = JSON.parse(stored) as OidcLoginState;
    } catch {
      throw new UnauthorizedException('Sesi SSO tidak valid');
    }
    if (
      !loginState ||
      loginState.state !== state ||
      typeof loginState.nonce !== 'string' ||
      typeof loginState.codeVerifier !== 'string' ||
      !Number.isSafeInteger(loginState.issuedAt) ||
      loginState.issuedAt > Date.now() + 30_000 ||
      Date.now() - loginState.issuedAt > 10 * 60 * 1000
    ) {
      throw new UnauthorizedException('Sesi SSO kedaluwarsa');
    }
    if (typeof query.error === 'string') throw new SsoProviderDeniedException();
    if (typeof query.code !== 'string' || query.code.length > 4096) {
      throw new UnauthorizedException('Kode SSO tidak valid');
    }

    try {
      const config = await this.getConfiguration();
      const currentUrl = new URL(this.requiredEnv('OIDC_REDIRECT_URI'));
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string') currentUrl.searchParams.set(key, value);
      }
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        expectedState: loginState.state,
        expectedNonce: loginState.nonce,
        pkceCodeVerifier: loginState.codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
        throw new UnauthorizedException('Identitas SSO tidak valid');
      }

      const nimClaim = process.env.OIDC_NIM_CLAIM || 'nim';
      const nim = claims[nimClaim];
      const email = claims.email;
      const emailVerified = claims.email_verified;
      if (
        typeof nim !== 'string' ||
        nim.trim().length === 0 ||
        nim.length > 32 ||
        typeof email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        emailVerified !== true
      ) {
        throw new UnauthorizedException('Klaim SSO mahasiswa tidak lengkap atau belum terverifikasi');
      }

      const displayName = claims.name;
      return {
        subject: claims.sub,
        nim: nim.trim(),
        email: email.toLowerCase(),
        name: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : email,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Autentikasi SSO gagal');
    }
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      const issuer = new URL(this.requiredEnv('OIDC_ISSUER_URL'));
      if (process.env.NODE_ENV === 'production' && issuer.protocol !== 'https:') {
        throw new ServiceUnavailableException('Issuer SSO produksi wajib memakai HTTPS');
      }
      const clientId = this.requiredEnv('OIDC_CLIENT_ID');
      const clientSecret = this.requiredEnv('OIDC_CLIENT_SECRET');
      this.configuration = oidc.discovery(issuer, clientId, clientSecret).catch((error) => {
        this.configuration = undefined;
        throw new ServiceUnavailableException('Provider SSO tidak dapat dijangkau', { cause: error });
      });
    }
    return this.configuration;
  }

  private async ensureRedisConnection(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }

  private requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new ServiceUnavailableException(`Konfigurasi ${name} belum tersedia`);
    return value;
  }

  private stateKey(state: string): string {
    return `auth:oidc:state:${state}`;
  }
}
