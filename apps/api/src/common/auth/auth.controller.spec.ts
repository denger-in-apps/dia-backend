import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser = require('cookie-parser');
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { AuthController } from './auth.controller';
import { MfaService } from './mfa.service';
import { AuthService } from './auth.service';
import { SsoProviderDeniedException, SSO_STRATEGY } from './sso-strategy';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AccessTokenService } from './access-token.service';
import { RolesGuard } from './roles.guard';
import { DATABASE_POOL } from '../../database/database.module';
import { AkademikService } from '../../modules/akademik/akademik.service';

describe('AuthController', () => {
  let app: INestApplication;
  let auth: {
    loginStaff: jest.Mock;
    loginStudent: jest.Mock;
    refresh: jest.Mock;
    logout: jest.Mock;
    getCurrentUser: jest.Mock;
    gantiPasswordStaf: jest.Mock;
  };
  let sso: {
    createAuthorizationUrl: jest.Mock;
    completeAuthorization: jest.Mock;
  };
  let jwt: { verifyAsync: jest.Mock };
  let pool: { query: jest.Mock };
  let mfa: Record<string, jest.Mock>;

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
      gantiPasswordStaf: jest.fn().mockResolvedValue(undefined),
      getCurrentUser: jest.fn().mockResolvedValue({
        id: 'user-id', role: 'DOSEN_ADMIN', nama: 'Dosen', email: 'dosen@example.edu',
      }),
    };
    mfa = {
      mulai: jest.fn().mockResolvedValue({ secret: 'S', otpauth_url: 'otpauth://x', berlaku_detik: 600 }),
      aktifkan: jest.fn().mockResolvedValue({
        accessToken: 'mfa-access', expiresIn: 900, user: { id: 'user-id', role: 'PSIKOLOG' },
        refreshToken: 'mfa-refresh', refreshTokenExpiresIn: 60,
      }),
      tokenUntukStafLogin: jest.fn().mockResolvedValue({ mfa_setup_token: 't', berlaku_detik: 600 }),
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

    pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ nim: null, status_aktif: true, terakhir_verifikasi_at: null }],
      }),
    };

    // Guard dipasang global persis seperti AuthModule agar test membuktikan
    // endpoint non-@Public() benar-benar terlindungi.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: SSO_STRATEGY, useValue: sso },
        { provide: JwtService, useValue: jwt },
        { provide: DATABASE_POOL, useValue: pool },
        { provide: AkademikService, useValue: { wajibAktif: jest.fn() } },
        { provide: MfaService, useValue: mfa },
        AccessTokenService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
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
    expect(auth.getCurrentUser).toHaveBeenCalledWith({ id: 'user-id', role: 'DOSEN_ADMIN' });
  });

  it('rejects /me without a bearer token through the global guard', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(auth.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects /me when the access token fails verification', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer forged-token')
      .expect(401);
    expect(auth.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects /me for a staff account that is no longer active', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer valid-access-token')
      .expect(403);
  });

  it('returns 503 instead of crashing when the failure URL is misconfigured', async () => {
    sso.completeAuthorization.mockRejectedValue(new SsoProviderDeniedException());
    const saved = process.env.FRONTEND_LOGIN_FAILURE_URL;
    delete process.env.FRONTEND_LOGIN_FAILURE_URL;
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/sso/callback?error=access_denied&state=valid-state')
        .expect(503);
      expect(response.body.error).toBe('kredensial');
    } finally {
      process.env.FRONTEND_LOGIN_FAILURE_URL = saved;
    }
  });

  it('lets staff change their password and clears the refresh cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/staff/password')
      .set('Authorization', 'Bearer valid-access-token')
      .send({ password_lama: 'lama-lama-lama', password_baru: 'baru-baru-baru-1' })
      .expect(204);
    expect(auth.gantiPasswordStaf).toHaveBeenCalledWith(
      { id: 'user-id', role: 'DOSEN_ADMIN' }, 'lama-lama-lama', 'baru-baru-baru-1',
    );
    expect(response.headers['set-cookie'][0]).toMatch(/^refresh_token=;/);
  });

  it('forbids students from the staff password endpoint', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'mhs', role: 'MAHASISWA', jti: 'j', iat: 1, exp: 9999999999 });
    pool.query.mockResolvedValue({ rows: [{ nim: '1', status_aktif: true, terakhir_verifikasi_at: new Date() }] });
    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/password')
      .set('Authorization', 'Bearer valid-access-token')
      .send({ password_lama: 'x', password_baru: 'y' })
      .expect(403);
    expect(auth.gantiPasswordStaf).not.toHaveBeenCalled();
  });

  it('lets staff with a temporary password reach /auth/me (to see wajib_ganti_password)', async () => {
    pool.query.mockResolvedValue({ rows: [{ nim: null, status_aktif: true, terakhir_verifikasi_at: null, wajib_ganti_password: true }] });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me').set('Authorization', 'Bearer valid-access-token').expect(200);
  });

  it('enrolls MFA with a setup token and sets the session cookie without exposing the refresh token', async () => {
    const mulai = await request(app.getHttpServer())
      .post('/api/v1/auth/staff/mfa/mulai').send({ mfa_setup_token: 'a.b.c' }).expect(200);
    expect(mulai.headers['cache-control']).toBe('no-store');
    expect(mfa.mulai).toHaveBeenCalledWith('a.b.c');

    const aktif = await request(app.getHttpServer())
      .post('/api/v1/auth/staff/mfa/aktifkan').send({ mfa_setup_token: 'a.b.c', otp: '123456' }).expect(200);
    expect(mfa.aktifkan).toHaveBeenCalledWith('a.b.c', '123456', expect.anything(), undefined);
    expect(aktif.body.accessToken).toBe('mfa-access');
    expect(aktif.body).not.toHaveProperty('refreshToken');
    expect(aktif.headers['set-cookie'][0]).toMatch(/^refresh_token=mfa-refresh;.*HttpOnly/);
  });

  it('issues a voluntary MFA setup token only to logged-in staff', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/staff/mfa/token').expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/mfa/token').set('Authorization', 'Bearer valid-access-token').expect(200);
    expect(mfa.tokenUntukStafLogin).toHaveBeenCalledWith({ id: 'user-id', role: 'DOSEN_ADMIN' });
  });
});
