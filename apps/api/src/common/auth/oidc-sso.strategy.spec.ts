jest.mock('openid-client', () => ({
  randomState: jest.fn(),
  randomNonce: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  discovery: jest.fn(),
  authorizationCodeGrant: jest.fn(),
}));

import { UnauthorizedException } from '@nestjs/common';
import * as oidc from 'openid-client';
import { OidcSsoStrategy } from './oidc-sso.strategy';
import { SsoProviderDeniedException } from './sso-strategy';

describe('OidcSsoStrategy', () => {
  const state = 'state_0123456789abcdefghijklmnopqrstuv';
  const nonce = 'nonce_0123456789abcdefghijklmnopqrstuv';
  const verifier = 'verifier_0123456789abcdefghijklmnopqrstuv';
  const config = { issuer: 'test-issuer' } as unknown as oidc.Configuration;
  let redis: {
    status: string;
    connect: jest.Mock;
    set: jest.Mock;
    call: jest.Mock;
  };
  let strategy: OidcSsoStrategy;
  let oidcMock: Record<string, jest.Mock>;

  beforeEach(() => {
    process.env.OIDC_ISSUER_URL = 'https://idp.example.edu';
    process.env.OIDC_CLIENT_ID = 'prototype-client';
    process.env.OIDC_CLIENT_SECRET = 'prototype-secret';
    process.env.OIDC_REDIRECT_URI = 'https://localhost/api/v1/auth/sso/callback';
    process.env.OIDC_NIM_CLAIM = 'nim';
    process.env.OIDC_SCOPES = 'openid email profile';
    process.env.NODE_ENV = 'test';

    oidcMock = jest.requireMock('openid-client') as Record<string, jest.Mock>;
    jest.clearAllMocks();
    oidcMock.randomState.mockReturnValue(state);
    oidcMock.randomNonce.mockReturnValue(nonce);
    oidcMock.randomPKCECodeVerifier.mockReturnValue(verifier);
    oidcMock.calculatePKCECodeChallenge.mockResolvedValue('pkce-challenge');
    oidcMock.discovery.mockResolvedValue(config);
    oidcMock.buildAuthorizationUrl.mockImplementation((_config, parameters) => {
      const url = new URL('https://idp.example.edu/authorize');
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
      return url;
    });

    redis = {
      status: 'wait',
      connect: jest.fn().mockImplementation(async () => { redis.status = 'ready'; }),
      set: jest.fn().mockResolvedValue('OK'),
      call: jest.fn(),
    };
    strategy = new OidcSsoStrategy(redis as never);
  });

  afterEach(() => {
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
    delete process.env.OIDC_NIM_CLAIM;
    delete process.env.OIDC_SCOPES;
    delete process.env.NODE_ENV;
  });

  it('creates an authorization URL with PKCE, state, and nonce and stores the verifier', async () => {
    const url = await strategy.createAuthorizationUrl();

    expect(url.origin).toBe('https://idp.example.edu');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('nonce')).toBe(nonce);
    expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, serializedState, expiryMode, ttlSeconds, setMode] = redis.set.mock.calls[0];
    expect(key).toBe(`auth:oidc:state:${state}`);
    expect(JSON.parse(serializedState)).toEqual({
      state, nonce, codeVerifier: verifier, issuedAt: expect.any(Number),
    });
    expect(expiryMode).toBe('EX');
    expect(ttlSeconds).toBe(600);
    expect(setMode).toBe('NX');
  });

  it('validates the ID token claims and returns the normalized student identity', async () => {
    const claims = jest.fn().mockReturnValue({
      sub: 'campus-subject-1',
      nim: ' 12345678 ',
      email: 'MAHASISWA@example.edu',
      email_verified: true,
      name: 'Mahasiswa Test',
    });
    const savedState = JSON.stringify({ state, nonce, codeVerifier: verifier, issuedAt: Date.now() });
    redis.call.mockResolvedValue(savedState);
    oidcMock.authorizationCodeGrant.mockResolvedValue({ claims });

    await strategy.createAuthorizationUrl();
    const identity = await strategy.completeAuthorization({ code: 'one-time-code', state });

    expect(identity).toEqual({
      subject: 'campus-subject-1',
      nim: '12345678',
      email: 'mahasiswa@example.edu',
      name: 'Mahasiswa Test',
    });
    expect(oidcMock.authorizationCodeGrant).toHaveBeenCalledWith(
      config,
      expect.any(URL),
      { expectedState: state, expectedNonce: nonce, pkceCodeVerifier: verifier },
    );
    expect(redis.call).toHaveBeenCalledWith('GETDEL', `auth:oidc:state:${state}`);
  });

  it('rejects an invalid state before contacting Redis', async () => {
    await expect(strategy.completeAuthorization({ code: 'one-time-code', state: 'bad' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.call).not.toHaveBeenCalled();
  });

  it('rejects unverified email claims', async () => {
    redis.call.mockResolvedValue(JSON.stringify({ state, nonce, codeVerifier: verifier, issuedAt: Date.now() }));
    oidcMock.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: 'campus-subject-1', nim: '12345678', email: 'mhs@example.edu', email_verified: false,
      }),
    });

    await strategy.createAuthorizationUrl();
    await expect(strategy.completeAuthorization({ code: 'one-time-code', state }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('marks an IdP access denial after consuming the matching state', async () => {
    redis.call.mockResolvedValue(JSON.stringify({ state, nonce, codeVerifier: verifier, issuedAt: Date.now() }));
    await strategy.createAuthorizationUrl();

    await expect(strategy.completeAuthorization({ error: 'access_denied', state }))
      .rejects.toBeInstanceOf(SsoProviderDeniedException);
    expect(redis.call).toHaveBeenCalledWith('GETDEL', `auth:oidc:state:${state}`);
  });
});
