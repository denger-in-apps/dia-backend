import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthenticatedUser, Role } from '../../common/auth/auth.types';
import { DaftarAuditLogQuery, FilterAuditLogQuery } from './audit-log.dto';
import { AuditLogService } from './audit-log.service';

const konteks = (request: Request) => ({ ip: request.ip, userAgent: request.get('user-agent') });

/** Audit log keamanan (PBI-21 / SCRUM-277, FR-ADM-06). Hanya Dosen Admin; tidak ada endpoint ubah/hapus. */
@Controller('admin/audit-log')
@Roles(Role.DOSEN_ADMIN)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  daftar(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: DaftarAuditLogQuery,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.auditLog.daftar(admin, query, konteks(request));
  }

  @Get('aksi')
  daftarAksi() {
    return this.auditLog.daftarAksi();
  }

  @Get('ekspor')
  async ekspor(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: FilterAuditLogQuery,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { csv, jumlah } = await this.auditLog.ekspor(admin, query, konteks(request));
    const tanggal = new Date().toISOString().slice(0, 10);
    response
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="audit-log-${tanggal}.csv"`)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Jumlah-Baris', String(jumlah))
      .send(csv);
  }
}
