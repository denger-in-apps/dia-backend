import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser = require('cookie-parser');
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SsoProviderDeniedException, SSO_STRATEGY } from './sso-strategy';

describe('AuthController', () => {
  let app: INestApplication;
  let auth: {
    loginStaff: jest.Mock;
    loginStudent: jest.Mock;
    refresh: jest.Mock;
    logout: jest.Mock;
    getCurrentUser: jest.Mock;
  };
  let sso: {
    createAuthorizationUrl: jest.Mock;
    completeAuthorization: jest.Mock;
  };
  let jwt: { verifyAsync: jest.Mock };

  const session = {
    accessToken: 'access-token',
    expiresIn: 900,
    user: { id: 'user-id', role: 'DOSEN_ADMIN' },
    refreshToken: 'private-refresh-token',
    refreshTokenExpiresIn: 604800,
  };

  beforeAll(() => {
    process.env.CORS_ORIGINS = 'https://localhost';
    process.env.FRONTEND_LOGIN_SUCCESS_URL = 'https://localhost/';
    process.env.FRONTEND_LOGIN_FAILURE_URL = 'https://localhost/masuk';
  });

  beforeEach(async () => {
    auth = {
      loginStaff: jest.fn().mockResolvedValue(session),
      loginStudent: jest.fn().mockResolvedValue({
        ...session,
        user: { id: 'student-id', role: 'MAHASISWA' },
      }),
      refresh: jest.fn().mockResolvedValue(session),
      logout: jest.fn().mockResolvedValue(undefined),
      getCurrentUser: jest.fn().mockResolvedValue({
        id: 'user-id', role: 'DOSEN_ADMIN', nama: 'Dosen', email: 'dosen@example.edu',
      }),
    };
    sso = {
      createAuthorizationUrl: jest.fn().mockResolvedValue(new URL('https://idp.example/authorize')),
      completeAuthorization: jest.fn().mockResolvedValue({
        subject: 'oidc-subject', nim: '12345678', email: 'mhs@example.edu', name: 'Mahasiswa',
      }),
    };
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-id', role: 'DOSEN_ADMIN', jti: 'token-id', iat: 1, exp: 9999999999,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: SSO_STRATEGY, useValue: sso },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('starts OIDC login by redirecting to the provider', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/login')
      .expect(302);

    expect(response.headers.location).toBe('https://idp.example/authorize');
    expect(sso.createAuthorizationUrl).toHaveBeenCalledTimes(1);
  });

  it('completes student SSO with an httpOnly refresh cookie and frontend redirect', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback?code=auth-code&state=valid-state')
      .expect(302);

    expect(response.headers.location).toBe('https://localhost/');
    expect(response.headers['set-cookie'][0]).toContain('refresh_token=private-refresh-token');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('Secure');
    expect(sso.completeAuthorization).toHaveBeenCalledWith({ code: 'auth-code', state: 'valid-state' });
    expect(auth.loginStudent).toHaveBeenCalledWith(
      expect.objectContaining({ nim: '12345678' }), '127.0.0.1', undefined,
    );
  });

  it('maps an identity-provider denial to the credentials error redirect', async () => {
    sso.completeAuthorization.mockRejectedValue(new SsoProviderDeniedException());

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback?error=access_denied&state=valid-state')
      .expect(302);

    expect(response.headers.location).toBe('https://localhost/masuk?error=kredensial');
    expect(auth.loginStudent).not.toHaveBeenCalled();
  });

  it('maps an inactive student to the inactive-account redirect', async () => {
    auth.loginStudent.mockRejectedValue(new ForbiddenException('AKUN_TIDAK_AKTIF'));

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback?code=auth-code&state=valid-state')
      .expect(302);

    expect(response.headers.location).toBe('https://localhost/masuk?error=akun_tidak_aktif');
  });

  it('validates staff login input and does not return the refresh token in JSON', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ role: 'DOSEN_ADMIN', email: 'dosen@example.edu', password: 'password-123' })
      .expect(200);

    expect(response.body).toEqual({
      accessToken: 'access-token',
      expiresIn: 900,
      user: { id: 'user-id', role: 'DOSEN_ADMIN' },
    });
    expect(JSON.stringify(response.body)).not.toContain('private-refresh-token');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('Secure');

    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ role: 'DOSEN_ADMIN', email: 'dosen@example.edu', password: 'password-123', extra: true })
      .expect(400);
    expect(auth.loginStaff).toHaveBeenCalledTimes(1);
  });

  it('refreshes only for an allowed Origin and forwards the refresh cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', 'https://localhost')
      .set('Cookie', 'refresh_token=old-refresh-token')
      .expect(200);

    expect(auth.refresh).toHaveBeenCalledWith(
      'old-refresh-token', '127.0.0.1', undefined,
    );
    expect(response.headers['set-cookie'][0]).toContain('refresh_token=private-refresh-token');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', 'https://attacker.example')
      .expect(403);
  });

  it('rejects a refresh request without a refresh cookie', async () => {
    auth.refresh.mockRejectedValue(new UnauthorizedException());

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', 'https://localhost')
      .expect(401);

    expect(auth.refresh).toHaveBeenCalledWith(undefined, '127.0.0.1', undefined);
  });

  it('rate-limits staff login attempts by client IP', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/staff/login')
        .send({ role: 'DOSEN_ADMIN', email: 'dosen@example.edu', password: 'password-123' })
        .expect(200);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ role: 'DOSEN_ADMIN', email: 'dosen@example.edu', password: 'password-123' })
      .expect(429);
  });

  it('returns the authenticated user profile from /me', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer valid-access-token')
      .expect(200);

    expect(jwt.verifyAsync).toHaveBeenCalledWith('valid-access-token', { algorithms: ['RS256'] });
    expect(response.body).toEqual({
      id: 'user-id', role: 'DOSEN_ADMIN', nama: 'Dosen', email: 'dosen@example.edu',
    });
  });
});
