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
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const auth_service_1 = require("./auth.service");
const sso_strategy_1 = require("./sso-strategy");
const staff_login_dto_1 = require("./dto/staff-login.dto");
const current_user_decorator_1 = require("./current-user.decorator");
const jwt_auth_guard_1 = require("./jwt-auth.guard");
const class_validator_1 = require("class-validator");
let AuthController = class AuthController {
    constructor(auth, sso) {
        this.auth = auth;
        this.sso = sso;
    }
    async ssoLogin(response) {
        const url = await this.sso.createAuthorizationUrl();
        response.redirect(common_1.HttpStatus.FOUND, url.href);
    }
    async ssoCallback(request, response) {
        try {
            const identity = await this.sso.completeAuthorization(request.query);
            const session = await this.auth.loginStudent(identity, request.ip, request.get('user-agent'));
            this.setRefreshCookie(response, session);
            response.redirect(common_1.HttpStatus.FOUND, this.frontendUrl('FRONTEND_LOGIN_SUCCESS_URL'));
        }
        catch (error) {
            const result = error instanceof common_1.ForbiddenException && error.message === 'AKUN_TIDAK_AKTIF'
                ? 'akun_tidak_aktif'
                : 'sso_gangguan';
            const failure = new URL(this.frontendUrl('FRONTEND_LOGIN_FAILURE_URL'));
            failure.searchParams.set('error', result);
            response.redirect(common_1.HttpStatus.FOUND, failure.href);
        }
    }
    async staffLogin(body, request, response) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new common_1.BadRequestException('Body login tidak valid');
        }
        const payload = body;
        const acceptedFields = new Set(['role', 'email', 'password', 'otp']);
        if (Object.keys(payload).some((key) => !acceptedFields.has(key))) {
            throw new common_1.BadRequestException('Body login tidak valid');
        }
        const dto = new staff_login_dto_1.StaffLoginDto();
        dto.role = payload.role;
        dto.email = payload.email;
        dto.password = payload.password;
        dto.otp = payload.otp;
        const validationErrors = await (0, class_validator_1.validate)(dto, {
            whitelist: true,
            forbidNonWhitelisted: true,
        });
        if (validationErrors.length)
            throw new common_1.BadRequestException('Body login tidak valid');
        const session = await this.auth.loginStaff(dto.role, dto.email, dto.password, dto.otp, request.ip, request.get('user-agent'));
        this.setRefreshCookie(response, session);
        response.status(common_1.HttpStatus.OK).json(this.publicSession(session));
    }
    async refresh(request, response) {
        this.assertTrustedOrigin(request.get('origin'));
        const session = await this.auth.refresh(request.cookies?.refresh_token, request.ip, request.get('user-agent'));
        this.setRefreshCookie(response, session);
        response.status(common_1.HttpStatus.OK).json(this.publicSession(session));
    }
    async logout(request, response) {
        this.assertTrustedOrigin(request.get('origin'));
        await this.auth.logout(request.cookies?.refresh_token);
        response.clearCookie('refresh_token', this.refreshCookieOptions());
        response.status(common_1.HttpStatus.NO_CONTENT).send();
    }
    async me(user) {
        const account = await this.auth.getCurrentUser(user);
        if (!account)
            throw new common_1.ForbiddenException('Akun tidak aktif');
        return account;
    }
    setRefreshCookie(response, session) {
        response.cookie('refresh_token', session.refreshToken, {
            ...this.refreshCookieOptions(),
            maxAge: session.refreshTokenExpiresIn * 1000,
        });
    }
    refreshCookieOptions() {
        return {
            httpOnly: true,
            secure: true,
            sameSite: process.env.REFRESH_COOKIE_SAME_SITE === 'none' ? 'none' : 'lax',
            path: '/api/v1/auth',
        };
    }
    publicSession(session) {
        const { refreshToken: _refreshToken, refreshTokenExpiresIn: _ttl, ...response } = session;
        return response;
    }
    assertTrustedOrigin(origin) {
        if (!origin)
            throw new common_1.ForbiddenException('Origin wajib untuk operasi sesi');
        let normalized;
        try {
            normalized = new URL(origin).origin;
        }
        catch {
            throw new common_1.ForbiddenException('Origin tidak diizinkan');
        }
        const allowed = (process.env.CORS_ORIGINS ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => {
            try {
                return new URL(item).origin;
            }
            catch {
                return '';
            }
        });
        if (!allowed.includes(normalized))
            throw new common_1.ForbiddenException('Origin tidak diizinkan');
    }
    frontendUrl(name) {
        const value = process.env[name];
        if (!value)
            throw new Error(`${name} belum dikonfigurasi`);
        const url = new URL(value);
        if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
            throw new Error(`${name} produksi wajib memakai HTTPS`);
        }
        return url.href;
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, common_1.Get)('sso/login'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "ssoLogin", null);
__decorate([
    (0, common_1.Get)('sso/callback'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "ssoCallback", null);
__decorate([
    (0, common_1.Post)('staff/login'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "staffLogin", null);
__decorate([
    (0, common_1.Post)('refresh'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "refresh", null);
__decorate([
    (0, common_1.Post)('logout'),
    (0, common_1.HttpCode)(common_1.HttpStatus.NO_CONTENT),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    (0, common_1.Get)('me'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "me", null);
exports.AuthController = AuthController = __decorate([
    (0, common_1.Controller)('auth'),
    __param(1, (0, common_1.Inject)(sso_strategy_1.SSO_STRATEGY)),
    __metadata("design:paramtypes", [auth_service_1.AuthService, Object])
], AuthController);
//# sourceMappingURL=auth.controller.js.map