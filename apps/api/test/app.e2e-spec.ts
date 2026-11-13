import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import request = require('supertest');
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';

jest.mock('openid-client', () => ({
  randomState: jest.fn(),
  randomNonce: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  discovery: jest.fn(),
  authorizationCodeGrant: jest.fn(),
}));

/**
 * Smoke e2e terhadap service Compose yang aktif (PostgreSQL + Redis + kunci JWT):
 *   docker compose exec api npm run test:e2e -- --runInBand
 * Aplikasi dikonfigurasi persis seperti main.ts (prefix /api/v1, ValidationPipe, cookie).
 */
describe('API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = 'https://localhost';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness and readiness outside the API prefix', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
  });

  it('does not expose the old Hello World root endpoint', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
    await request(app.getHttpServer()).get('/api/v1').expect(404);
  });

  it('rejects staff login with unknown credentials', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/staff/login')
      .send({ role: 'DOSEN_ADMIN', email: 'missing@example.edu', password: 'wrong-password' })
      .expect(401);
  });

  it('rejects refresh without a cookie', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', 'https://localhost')
      .expect(401);
  });

  it('requires a bearer token for protected endpoints', async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/booking', '/api/v1/genta/sos/aktif', '/api/v1/psikolog/sesi']) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });
});
