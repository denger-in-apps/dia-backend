import { readFileSync } from 'fs';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from '../redis/redis-throttler.storage';
import { AUTH_REDIS } from './sso-state.lifecycle';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AccessTokenService } from './access-token.service';
import { OidcSsoStrategy } from './oidc-sso.strategy';
import { RedisModule } from '../redis/redis.module';
import { RolesGuard } from './roles.guard';
import { SSO_STRATEGY } from './sso-strategy';
import { AkademikModule } from '../../modules/akademik/akademik.module';
import { MfaService } from './mfa.service';
import { MfaTokenService } from './mfa-token.service';
import { LockoutLoginService } from './lockout-login.service';
import { AuditModule } from '../audit/audit.module';

function requiredFile(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} wajib diisi`);
  return readFileSync(path, 'utf8');
}

@Module({
  imports: [
    CryptoModule,
    RedisModule,
    AkademikModule,
    AuditModule,
    // Rate limit global 100 req/menit/IP (02-backend.md §12), tersimpan di Redis agar
    // berlaku lintas instance; endpoint sensitif menimpa lewat @Throttle().
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [AUTH_REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
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
    AccessTokenService,
    MfaTokenService,
    MfaService,
    LockoutLoginService,
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
    // Urutan penting: rate limit sebelum verifikasi JWT (yang menyentuh DB).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // JwtModule diekspor agar modul lain (mis. token konfirmasi Genta) memakai kunci RS256 yang sama.
  exports: [JwtModule, AccessTokenService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
