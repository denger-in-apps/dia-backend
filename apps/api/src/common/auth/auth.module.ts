import { readFileSync } from 'fs';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
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
    AccessTokenService,
    MfaTokenService,
    MfaService,
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
  ],
  // JwtModule diekspor agar modul lain (mis. token konfirmasi Genta) memakai kunci RS256 yang sama.
  exports: [JwtModule, AccessTokenService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
