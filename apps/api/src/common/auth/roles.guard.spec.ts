
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';
import { Role } from './auth.types';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let request: { user?: { id: string; role: string } };
  let context: ExecutionContext;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };

    request = {
      user: { id: 'user-001', role: Role.MAHASISWA },
    };

    context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows access when no role metadata is defined', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows mahasiswa when MAHASISWA role is required', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.MAHASISWA]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows psikolog when PSIKOLOG role is required', () => {
    request.user!.role = Role.PSIKOLOG;
    reflector.getAllAndOverride.mockReturnValue([Role.PSIKOLOG]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows dosen admin when DOSEN_ADMIN role is required', () => {
    request.user!.role = Role.DOSEN_ADMIN;
    reflector.getAllAndOverride.mockReturnValue([Role.DOSEN_ADMIN]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects mahasiswa accessing psikolog-only resource', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.PSIKOLOG]);

    expect(() => guard.canActivate(context)).toThrow(
      new ForbiddenException('Peran tidak memiliki akses ke resource ini'),
    );
  });

  it('rejects mahasiswa accessing dosen admin-only resource', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.DOSEN_ADMIN]);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects access when user is missing', () => {
    request.user = undefined;
    reflector.getAllAndOverride.mockReturnValue([Role.MAHASISWA]);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows access when user has one of the permitted roles', () => {
    request.user!.role = Role.PSIKOLOG;
    reflector.getAllAndOverride.mockReturnValue([
      Role.MAHASISWA,
      Role.PSIKOLOG,
    ]);

    expect(guard.canActivate(context)).toBe(true);
  });
});
