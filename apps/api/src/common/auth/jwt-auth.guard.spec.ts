import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { AkademikService } from '../../modules/akademik/akademik.service';
import { AccessTokenService } from './access-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

type Role = 'MAHASISWA' | 'PSIKOLOG' | 'DOSEN_ADMIN';

describe('JwtAuthGuard', () => {
  const claims = {
    sub: 'student-id',
    role: 'MAHASISWA' as Role,
    jti: 'token-id',
    iat: 1,
    exp: 9_999_999_999,
  };

  let guard: JwtAuthGuard;
  let jwt: { verifyAsync: jest.Mock };
  let pool: { query: jest.Mock };
  let akademik: { wajibAktif: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let request: { headers: { authorization?: string }; user?: { id: string; role: Role } };
  let context: ExecutionContext;

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn().mockResolvedValue(claims) };
    pool = { query: jest.fn() };
    akademik = { wajibAktif: jest.fn().mockResolvedValue(undefined) };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    request = { headers: { authorization: 'Bearer valid-token' } };
    context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    const accessToken = new AccessTokenService(
      jwt as unknown as JwtService,
      pool as unknown as Pool,
      akademik as unknown as AkademikService,
    );
    guard = new JwtAuthGuard(accessToken, reflector as unknown as Reflector);
  });

  it('rejects a request without a Bearer token', async () => {
    request.headers.authorization = undefined;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('allows a route explicitly marked public without verifying a token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    request.headers.authorization = undefined;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('signature invalid'));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('rejects access using an old token when the student account is inactive', async () => {
    pool.query.mockResolvedValue({ rows: [{ nim: '12345678', status_aktif: false, terakhir_verifikasi_at: new Date() }] });
    await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    expect(jwt.verifyAsync).toHaveBeenCalledWith('valid-token', { algorithms: ['RS256'] });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM mahasiswa'), ['student-id']);
    expect(akademik.wajibAktif).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('rejects access when the student account no longer exists', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    expect(request.user).toBeUndefined();
  });

  it('allows access when the student account is active', async () => {
    pool.query.mockResolvedValue({ rows: [{ nim: '12345678', status_aktif: true, terakhir_verifikasi_at: new Date() }] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'student-id', role: 'MAHASISWA' });
  });

  it('allows access when the psychologist account is active', async () => {
    jwt.verifyAsync.mockResolvedValue({ ...claims, sub: 'psychologist-id', role: 'PSIKOLOG' });
    pool.query.mockResolvedValue({ rows: [{ status_aktif: true }] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status_akun = 'AKTIF'"), ['psychologist-id']);
    expect(request.user).toEqual({ id: 'psychologist-id', role: 'PSIKOLOG' });
  });

  it('rejects access when the psychologist account is inactive', async () => {
    jwt.verifyAsync.mockResolvedValue({ ...claims, sub: 'psychologist-id', role: 'PSIKOLOG' });
    pool.query.mockResolvedValue({ rows: [] });
    await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    expect(request.user).toBeUndefined();
  });

  it('allows access when the dosen admin account is active', async () => {
    jwt.verifyAsync.mockResolvedValue({ ...claims, sub: 'admin-id', role: 'DOSEN_ADMIN' });
    pool.query.mockResolvedValue({ rows: [{ status_aktif: true }] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM dosen_admin'), ['admin-id']);
    expect(request.user).toEqual({ id: 'admin-id', role: 'DOSEN_ADMIN' });
  });

  it('rejects access when the dosen admin account is inactive', async () => {
    jwt.verifyAsync.mockResolvedValue({ ...claims, sub: 'admin-id', role: 'DOSEN_ADMIN' });
    pool.query.mockResolvedValue({ rows: [] });
    await expect(guard.canActivate(context)).rejects.toThrow(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    expect(request.user).toBeUndefined();
  });
});
