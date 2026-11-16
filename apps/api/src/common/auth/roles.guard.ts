import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { ROLES_KEY } from './roles.decorator';
import { AuthenticatedUser, UserRole } from './auth.types';

interface RequestRingkas {
  user?: AuthenticatedUser;
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    /** Opsional agar guard tetap dapat dipakai tanpa audit (mis. di test unit). */
    @Optional() private readonly audit?: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const request = context.switchToHttp().getRequest<RequestRingkas>();
    const user = request.user;
    if (!user || !required.includes(user.role)) {
      this.catatDitolak(request, required);
      throw new ForbiddenException('Peran tidak memiliki akses ke resource ini');
    }
    return true;
  }

  /**
   * `AKSES_DITOLAK` (02-backend.md §10, PBI-21): pengguna terautentikasi yang mencoba endpoint
   * di luar perannya. Best-effort — kegagalan audit tidak mengubah respons 403.
   */
  private catatDitolak(request: RequestRingkas, required: UserRole[]): void {
    if (!this.audit || !request.user) return;
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const userAgent = request.headers?.['user-agent'];
    void this.audit.catat({
      aktor: request.user,
      aksi: 'AKSES_DITOLAK',
      resourceType: 'endpoint',
      resourceId: `${request.method ?? '?'} ${path}`.slice(0, 300),
      hasil: 'DITOLAK',
      ip: request.ip,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      metadata: { peran_dibutuhkan: required },
    }).catch(() => undefined);
  }
}
