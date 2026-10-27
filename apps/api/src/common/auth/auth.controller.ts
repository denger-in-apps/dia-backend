import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SsoProviderDeniedException, SsoStrategy, SSO_STRATEGY } from './sso-strategy';
import { StaffLoginDto } from './dto/staff-login.dto';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser, AuthProfile, AuthSession } from './auth.types';
import { validate } from 'class-validator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(SSO_STRATEGY) private readonly sso: SsoStrategy,
  ) {}

  @Get('sso/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async ssoLogin(@Res() response: Response): Promise<void> {
    const url = await this.sso.createAuthorizationUrl();
    response.redirect(HttpStatus.FOUND, url.href);
  }

  @Get('sso/callback')
  async ssoCallback(@Req() request: Request, @Res() response: Response): Promise<void> {
    try {
      const identity = await this.sso.completeAuthorization(request.query as Record<string, unknown>);
      const session = await this.auth.loginStudent(
        identity,
        request.ip,
        request.get('user-agent'),
      );
      this.setRefreshCookie(response, session);
      response.redirect(HttpStatus.FOUND, this.frontendUrl('FRONTEND_LOGIN_SUCCESS_URL'));
    } catch (error) {
      const result = this.ssoFailureCode(error);
      const failure = new URL(this.frontendUrl('FRONTEND_LOGIN_FAILURE_URL'));
      failure.searchParams.set('error', result);
      response.redirect(HttpStatus.FOUND, failure.href);
    }
  }

  @Post('staff/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async staffLogin(
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Body login tidak valid');
    }
    const payload = body as Record<string, unknown>;
    const acceptedFields = new Set(['role', 'email', 'password', 'otp']);
    if (Object.keys(payload).some((key) => !acceptedFields.has(key))) {
      throw new BadRequestException('Body login tidak valid');
    }
    const dto = new StaffLoginDto();
    dto.role = payload.role as StaffLoginDto['role'];
    dto.email = payload.email as string;
    dto.password = payload.password as string;
    dto.otp = payload.otp as string | undefined;
    const validationErrors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (validationErrors.length) throw new BadRequestException('Body login tidak valid');
    const session = await this.auth.loginStaff(
      dto.role,
      dto.email,
      dto.password,
      dto.otp,
      request.ip,
      request.get('user-agent'),
    );
    this.setRefreshCookie(response, session);
    response.status(HttpStatus.OK).json(this.publicSession(session));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTrustedOrigin(request.get('origin'));
    const session = await this.auth.refresh(
      request.cookies?.refresh_token,
      request.ip,
      request.get('user-agent'),
    );
    this.setRefreshCookie(response, session);
    response.status(HttpStatus.OK).json(this.publicSession(session));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.assertTrustedOrigin(request.get('origin'));
    await this.auth.logout(request.cookies?.refresh_token);
    response.clearCookie('refresh_token', this.refreshCookieOptions());
    response.status(HttpStatus.NO_CONTENT).send();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser): Promise<AuthProfile> {
    const account = await this.auth.getCurrentUser(user);
    if (!account) throw new ForbiddenException('Akun tidak aktif');
    return account;
  }

  private setRefreshCookie(response: Response, session: AuthSession): void {
    response.cookie('refresh_token', session.refreshToken, {
      ...this.refreshCookieOptions(),
      maxAge: session.refreshTokenExpiresIn * 1000,
    });
  }

  private refreshCookieOptions() {
    return {
      httpOnly: true,
      secure: true,
      sameSite: process.env.REFRESH_COOKIE_SAME_SITE === 'none' ? 'none' as const : 'lax' as const,
      path: '/api/v1/auth',
    };
  }

  private publicSession(session: AuthSession) {
    const { refreshToken: _refreshToken, refreshTokenExpiresIn: _ttl, ...response } = session;
    return response;
  }

  private assertTrustedOrigin(origin: string | undefined): void {
    if (!origin) throw new ForbiddenException('Origin wajib untuk operasi sesi');
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new ForbiddenException('Origin tidak diizinkan');
    }
    const allowed = (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        try { return new URL(item).origin; } catch { return ''; }
      });
    if (!allowed.includes(normalized)) throw new ForbiddenException('Origin tidak diizinkan');
  }

  private ssoFailureCode(error: unknown): string {
    if (error instanceof SsoProviderDeniedException) return 'kredensial';
    if (error instanceof ForbiddenException && error.message === 'AKUN_TIDAK_AKTIF') {
      return 'akun_tidak_aktif';
    }
    if (error instanceof ServiceUnavailableException) return 'sso_gangguan';
    return 'sso_gagal';
  }

  private frontendUrl(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} belum dikonfigurasi`);
    const url = new URL(value);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error(`${name} produksi wajib memakai HTTPS`);
    }
    return url.href;
  }
}
