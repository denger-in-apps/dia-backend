import { ArgumentsHost, ForbiddenException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { LokasiRoleDitolakFilter } from './lokasi-role-ditolak.filter';

describe('LokasiRoleDitolakFilter (PBI-06)', () => {
  const idSos = '55555555-5555-4555-8555-555555555555';
  let audit: { catat: jest.Mock };
  let filter: LokasiRoleDitolakFilter;
  let response: { status: jest.Mock; json: jest.Mock };

  const host = (request: Record<string, unknown>) => ({
    switchToHttp: () => ({
      getRequest: () => ({ ip: '10.0.0.9', get: () => 'jest-agent', params: { id: idSos }, ...request }),
      getResponse: () => response,
    }),
  }) as unknown as ArgumentsHost;
  const roleDitolak = () => new ForbiddenException('Peran tidak memiliki akses ke resource ini');

  beforeEach(() => {
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    filter = new LokasiRoleDitolakFilter(audit as unknown as AuditService);
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  it.each(['MAHASISWA', 'DOSEN_ADMIN'])('audits a %s denied by RolesGuard and keeps the default 403 body', async (role) => {
    const user = { id: '11111111-1111-4111-8111-111111111111', role };
    await filter.catch(roleDitolak(), host({ user, headers: { authorization: 'Bearer rahasia' } }));

    expect(audit.catat).toHaveBeenCalledTimes(1);
    expect(audit.catat).toHaveBeenCalledWith({
      aktor: user,
      aksi: 'SOS_LOKASI_READ',
      resourceType: 'log_sos',
      resourceId: idSos,
      hasil: 'DITOLAK',
      ip: '10.0.0.9',
      userAgent: 'jest-agent',
      metadata: { alasan: 'ROLE_TIDAK_DIIZINKAN' },
    });
    expect(JSON.stringify(audit.catat.mock.calls)).not.toContain('rahasia');
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      message: 'Peran tidak memiliki akses ke resource ini', error: 'Forbidden', statusCode: 403,
    });
  });

  it('does not audit PSIKOLOG denials (already audited by the service → no duplicate)', async () => {
    const forbidden = new ForbiddenException({ kode: 'BUKAN_PENANGAN_KASUS', pesan: 'x' });
    await filter.catch(forbidden, host({ user: { id: 'p', role: 'PSIKOLOG' } }));
    expect(audit.catat).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ kode: 'BUKAN_PENANGAN_KASUS', pesan: 'x' });
  });

  it('does not audit unauthenticated / inactive-account rejections (no request.user)', async () => {
    await filter.catch(new ForbiddenException('AKUN_TIDAK_AKTIF'), host({}));
    expect(audit.catat).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it('omits a non-UUID id from the audit record', async () => {
    await filter.catch(roleDitolak(), host({ user: { id: 'm', role: 'MAHASISWA' }, params: { id: "x' OR 1=1" } }));
    expect(audit.catat.mock.calls[0][0].resourceId).toBeUndefined();
  });

  it('still answers 403 when writing the audit fails', async () => {
    audit.catat.mockRejectedValue(new Error('db down'));
    await filter.catch(roleDitolak(), host({ user: { id: 'm', role: 'MAHASISWA' } }));
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
