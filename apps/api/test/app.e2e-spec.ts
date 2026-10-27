import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module';

jest.mock('openid-client', () => ({
  randomState: jest.fn(),
  randomNonce: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  discovery: jest.fn(),
  authorizationCodeGrant: jest.fn(),
}));

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeAll(() => {
    process.env.CORS_ORIGINS = 'https://localhost';
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('rejects staff login with unknown credentials', () => {
    return request(app.getHttpServer())
      .post('/auth/staff/login')
      .send({ role: 'DOSEN_ADMIN', email: 'missing@example.edu', password: 'wrong-password' })
      .expect(401);
  });

  it('rejects refresh without a cookie', () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', 'https://localhost')
      .expect(401);
  });

  it('requires a bearer token for the current-user endpoint', () => {
    return request(app.getHttpServer())
      .get('/auth/me')
      .expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
