import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AccessTokenService } from './access-token.service';
import { IZINKAN_SAAT_AKADEMIK_GANGGUAN } from './akademik-gangguan.decorator';

/** Ambil token dari header `Authorization: Bearer <token>`. */
export function bearerToken(authorization: unknown): string | null {
  const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessToken: AccessTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = bearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Token tidak valid');

    const izinkanSaatAkademikGangguan = this.reflector.getAllAndOverride<boolean>(IZINKAN_SAAT_AKADEMIK_GANGGUAN, [
      context.getHandler(),
      context.getClass(),
    ]);
    const { user } = await this.accessToken.verifikasi(token, { izinkanSaatAkademikGangguan });
    request.user = user;
    return true;
  }
}
