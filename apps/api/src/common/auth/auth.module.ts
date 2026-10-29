import { readFileSync } from 'fs';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OidcSsoStrategy } from './oidc-sso.strategy';
import { AUTH_REDIS, AuthRedisLifecycle } from './sso-state.lifecycle';
import { RolesGuard } from './roles.guard';
import { SSO_STRATEGY } from './sso-strategy';
import { AkademikModule } from '../../modules/akademik/akademik.module';

function requiredFile(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} wajib diisi`);
  return readFileSync(path, 'utf8');
}

@Module({
  imports: [
    CryptoModule,
    AkademikModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    JwtModule.registerAsync({
      useFactory: () => ({
        privateKey: requiredFile('JWT_PRIVATE_KEY_PATH'),
        publicKey: requiredFile('JWT_PUBLIC_KEY_PATH'),
        signOptions: {
          algorithm: 'RS256' as const,
          expiresIn: 900,
          issuer: process.env.JWT_ISSUER || 'dia-backend',
          audience: process.env.JWT_AUDIENCE || 'dia-api',
        },
        verifyOptions: {
          algorithms: ['RS256'] as const,
          issuer: process.env.JWT_ISSUER || 'dia-backend',
          audience: process.env.JWT_AUDIENCE || 'dia-api',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OidcSsoStrategy,
    {
      provide: SSO_STRATEGY,
      useFactory: (oidc: OidcSsoStrategy) => {
        const protocol = process.env.SSO_PROTOCOL || 'oidc';
        if (protocol !== 'oidc') {
          throw new Error(`SSO_PROTOCOL=${protocol} belum memiliki adapter terpasang`);
        }
        return oidc;
      },
      inject: [OidcSsoStrategy],
    },
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    {
      provide: AUTH_REDIS,
      useFactory: () => {
        const redis = new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => attempt <= 2 ? 100 : null,
        });
        redis.on('error', () => undefined);
        return redis;
      },
    },
    AuthRedisLifecycle,
  ],
  exports: [JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
