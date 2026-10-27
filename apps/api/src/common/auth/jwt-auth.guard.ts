import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenClaims, USER_ROLES } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new UnauthorizedException('Token tidak valid');

    try {
      const claims = await this.jwtService.verifyAsync<AccessTokenClaims>(match[1], {
        algorithms: ['RS256'],
      });
      if (
        !claims.sub ||
        !claims.jti ||
        !USER_ROLES.includes(claims.role) ||
        !claims.iat ||
        !claims.exp
      ) {
        throw new Error('Invalid access-token claims');
      }
      request.user = { id: claims.sub, role: claims.role };
      return true;
    } catch {
      throw new UnauthorizedException('Token tidak valid atau sudah kedaluwarsa');
    }
  }
}
