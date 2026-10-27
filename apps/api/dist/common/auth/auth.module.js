"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = void 0;
const fs_1 = require("fs");
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const throttler_1 = require("@nestjs/throttler");
const ioredis_1 = require("ioredis");
const crypto_module_1 = require("../crypto/crypto.module");
const auth_controller_1 = require("./auth.controller");
const auth_service_1 = require("./auth.service");
const jwt_auth_guard_1 = require("./jwt-auth.guard");
const oidc_sso_strategy_1 = require("./oidc-sso.strategy");
const sso_state_lifecycle_1 = require("./sso-state.lifecycle");
const roles_guard_1 = require("./roles.guard");
const sso_strategy_1 = require("./sso-strategy");
function requiredFile(name) {
    const path = process.env[name];
    if (!path)
        throw new Error(`${name} wajib diisi`);
    return (0, fs_1.readFileSync)(path, 'utf8');
}
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Module)({
        imports: [
            crypto_module_1.CryptoModule,
            throttler_1.ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
            jwt_1.JwtModule.registerAsync({
                useFactory: () => ({
                    privateKey: requiredFile('JWT_PRIVATE_KEY_PATH'),
                    publicKey: requiredFile('JWT_PUBLIC_KEY_PATH'),
                    signOptions: {
                        algorithm: 'RS256',
                        expiresIn: 900,
                        issuer: process.env.JWT_ISSUER || 'dia-backend',
                        audience: process.env.JWT_AUDIENCE || 'dia-api',
                    },
                    verifyOptions: {
                        algorithms: ['RS256'],
                        issuer: process.env.JWT_ISSUER || 'dia-backend',
                        audience: process.env.JWT_AUDIENCE || 'dia-api',
                    },
                }),
            }),
        ],
        controllers: [auth_controller_1.AuthController],
        providers: [
            auth_service_1.AuthService,
            oidc_sso_strategy_1.OidcSsoStrategy,
            {
                provide: sso_strategy_1.SSO_STRATEGY,
                useFactory: (oidc) => {
                    const protocol = process.env.SSO_PROTOCOL || 'oidc';
                    if (protocol !== 'oidc') {
                        throw new Error(`SSO_PROTOCOL=${protocol} belum memiliki adapter terpasang`);
                    }
                    return oidc;
                },
                inject: [oidc_sso_strategy_1.OidcSsoStrategy],
            },
            jwt_auth_guard_1.JwtAuthGuard,
            roles_guard_1.RolesGuard,
            {
                provide: sso_state_lifecycle_1.AUTH_REDIS,
                useFactory: () => {
                    const redis = new ioredis_1.default({
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
            sso_state_lifecycle_1.AuthRedisLifecycle,
        ],
        exports: [jwt_auth_guard_1.JwtAuthGuard, roles_guard_1.RolesGuard],
    })
], AuthModule);
//# sourceMappingURL=auth.module.js.map