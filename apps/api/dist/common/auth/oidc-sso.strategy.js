"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OidcSsoStrategy = void 0;
const common_1 = require("@nestjs/common");
const oidc = require("openid-client");
const ioredis_1 = require("ioredis");
const sso_state_lifecycle_1 = require("./sso-state.lifecycle");
const common_2 = require("@nestjs/common");
let OidcSsoStrategy = class OidcSsoStrategy {
    constructor(redis) {
        this.redis = redis;
    }
    async createAuthorizationUrl() {
        const config = await this.getConfiguration();
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
        const payload = { state, nonce, codeVerifier, issuedAt: Date.now() };
        await this.ensureRedisConnection();
        const saved = await this.redis.set(this.stateKey(state), JSON.stringify(payload), 'EX', 600, 'NX');
        if (saved !== 'OK')
            throw new common_1.ServiceUnavailableException('Gagal memulai login SSO');
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
    async completeAuthorization(query) {
        const state = typeof query.state === 'string' ? query.state : '';
        if (!state || !/^[A-Za-z0-9_-]{20,256}$/.test(state)) {
            throw new common_1.UnauthorizedException('Respons SSO tidak valid');
        }
        await this.ensureRedisConnection();
        const stored = await this.redis.call('GETDEL', this.stateKey(state));
        if (typeof stored !== 'string')
            throw new common_1.UnauthorizedException('Sesi SSO kedaluwarsa atau sudah digunakan');
        let loginState;
        try {
            loginState = JSON.parse(stored);
        }
        catch {
            throw new common_1.UnauthorizedException('Sesi SSO tidak valid');
        }
        if (Date.now() - loginState.issuedAt > 10 * 60 * 1000) {
            throw new common_1.UnauthorizedException('Sesi SSO kedaluwarsa');
        }
        if (typeof query.error === 'string')
            throw new common_1.UnauthorizedException('Login SSO dibatalkan');
        if (typeof query.code !== 'string' || query.code.length > 4096) {
            throw new common_1.UnauthorizedException('Kode SSO tidak valid');
        }
        try {
            const config = await this.getConfiguration();
            const currentUrl = new URL(this.requiredEnv('OIDC_REDIRECT_URI'));
            for (const [key, value] of Object.entries(query)) {
                if (typeof value === 'string')
                    currentUrl.searchParams.set(key, value);
            }
            const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
                expectedState: loginState.state,
                expectedNonce: loginState.nonce,
                pkceCodeVerifier: loginState.codeVerifier,
            });
            const claims = tokens.claims();
            if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
                throw new common_1.UnauthorizedException('Identitas SSO tidak valid');
            }
            const nimClaim = process.env.OIDC_NIM_CLAIM || 'nim';
            const nim = claims[nimClaim];
            const email = claims.email;
            const emailVerified = claims.email_verified;
            if (typeof nim !== 'string' ||
                nim.trim().length === 0 ||
                nim.length > 32 ||
                typeof email !== 'string' ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
                emailVerified !== true) {
                throw new common_1.UnauthorizedException('Klaim SSO mahasiswa tidak lengkap atau belum terverifikasi');
            }
            const displayName = claims.name;
            return {
                subject: claims.sub,
                nim: nim.trim(),
                email: email.toLowerCase(),
                name: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : email,
            };
        }
        catch (error) {
            if (error instanceof common_1.UnauthorizedException)
                throw error;
            throw new common_1.UnauthorizedException('Autentikasi SSO gagal');
        }
    }
    async getConfiguration() {
        if (!this.configuration) {
            const issuer = new URL(this.requiredEnv('OIDC_ISSUER_URL'));
            if (process.env.NODE_ENV === 'production' && issuer.protocol !== 'https:') {
                throw new common_1.ServiceUnavailableException('Issuer SSO produksi wajib memakai HTTPS');
            }
            const clientId = this.requiredEnv('OIDC_CLIENT_ID');
            const clientSecret = this.requiredEnv('OIDC_CLIENT_SECRET');
            this.configuration = oidc.discovery(issuer, clientId, clientSecret).catch((error) => {
                this.configuration = undefined;
                throw new common_1.ServiceUnavailableException('Provider SSO tidak dapat dijangkau', { cause: error });
            });
        }
        return this.configuration;
    }
    async ensureRedisConnection() {
        if (this.redis.status === 'wait')
            await this.redis.connect();
    }
    requiredEnv(name) {
        const value = process.env[name]?.trim();
        if (!value)
            throw new common_1.ServiceUnavailableException(`Konfigurasi ${name} belum tersedia`);
        return value;
    }
    stateKey(state) {
        return `auth:oidc:state:${state}`;
    }
};
exports.OidcSsoStrategy = OidcSsoStrategy;
exports.OidcSsoStrategy = OidcSsoStrategy = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_2.Inject)(sso_state_lifecycle_1.AUTH_REDIS)),
    __metadata("design:paramtypes", [ioredis_1.default])
], OidcSsoStrategy);
//# sourceMappingURL=oidc-sso.strategy.js.map