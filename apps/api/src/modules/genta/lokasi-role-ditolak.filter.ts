import { ArgumentsHost, Catch, ExceptionFilter, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hanya dipasang pada `GET /psikolog/sos/:id/lokasi` (PBI-06). RolesGuard global menolak role
 * yang salah sebelum service berjalan, sehingga percobaan itu tidak pernah tercatat sebagai
 * `SOS_LOKASI_READ`. Filter ini mencatatnya tanpa mengubah RBAC global maupun respons:
 * - hanya pengguna terautentikasi (request.user ada) dengan role selain PSIKOLOG;
 * - penolakan untuk PSIKOLOG (bukan penangan) sudah diaudit oleh service → tidak dicatat ganda;
 * - tidak mencatat token, koordinat, atau secret; ID hanya dicatat bila UUID valid.
 */
@Catch(ForbiddenException)
@Injectable()
export class LokasiRoleDitolakFilter implements ExceptionFilter {
  private readonly logger = new Logger(LokasiRoleDitolakFilter.name);

  constructor(private readonly audit: AuditService) {}

  async catch(exception: ForbiddenException, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const user = request.user;

    if (user && user.role !== Role.PSIKOLOG) {
      const id = request.params?.id;
      try {
        await this.audit.catat({
          aktor: user,
          aksi: 'SOS_LOKASI_READ',
          resourceType: 'log_sos',
          resourceId: typeof id === 'string' && UUID.test(id) ? id : undefined,
          hasil: 'DITOLAK',
          ip: request.ip,
          userAgent: request.get('user-agent'),
          metadata: { alasan: 'ROLE_TIDAK_DIIZINKAN' },
        });
      } catch (error) {
        // Kegagalan audit tidak boleh mengubah respons 403.
        this.logger.error(`Audit SOS_LOKASI_READ gagal: ${(error as Error).message}`);
      }
    }

    // Respons identik dengan penanganan bawaan Nest untuk HttpException.
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
