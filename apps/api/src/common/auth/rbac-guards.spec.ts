import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, bearerToken } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, Roles } from './roles.decorator';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, Role } from './auth.types';

/**
 * PBI-04 RBAC — unit test guard & dekorator sesuai arsitektur saat ini:
 * JwtAuthGuard mendelegasikan verifikasi token + status akun ke AccessTokenService.
 */

class Bebas { handler() { return 'ok'; } }
@Roles(Role.PSIKOLOG)
class KhususPsikolog {
  handler() { return 'ok'; }
  @Roles(Role.DOSEN_ADMIN) khususAdmin() { return 'ok'; }
  @Public() publik() { return 'ok'; }
}
@Public()
class Publik { handler() { return 'ok'; } }
class MultiRole { @Roles(Role.MAHASISWA, Role.PSIKOLOG) handler() { return 'ok'; } }

function ctx(cls: { prototype: object }, method: string, request: Record<string, unknown>): ExecutionContext {
  const handler = (cls.prototype as Record<string, unknown>)[method] as () => unknown;
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = (role: AuthenticatedUser['role']): AuthenticatedUser => ({ id: `id-${role}`, role });

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def', 'abc.def'],
    ['bearer abc', 'abc'],
    ['Bearer   abc', 'abc'],
  ])('membaca token dari %p', (header, token) => expect(bearerToken(header)).toBe(token));

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Token abc', 123, ['Bearer abc']])(
    'menolak header %p', (header) => expect(bearerToken(header)).toBeNull(),
  );
});

describe('JwtAuthGuard', () => {
  const reflector = new Reflector();
  let verifikasi: jest.Mock;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verifikasi = jest.fn().mockResolvedValue({ user: user('PSIKOLOG'), exp: 9_999_999_999 });
    guard = new JwtAuthGuard({ verifikasi } as never, reflector);
  });

  it('mengizinkan route @Public() tanpa token dan tanpa menyentuh verifikasi', async () => {
    await expect(guard.canActivate(ctx(Publik, 'handler', { headers: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(KhususPsikolog, 'publik', { headers: {} }))).resolves.toBe(true);
    expect(verifikasi).not.toHaveBeenCalled();
  });

  it('menolak 401 bila Authorization tidak ada atau bukan Bearer (default terlindungi)', async () => {
    for (const headers of [{}, { authorization: 'Basic x' }, { authorization: '' }]) {
      await expect(guard.canActivate(ctx(Bebas, 'handler', { headers }))).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(verifikasi).not.toHaveBeenCalled();
  });

  it('memasang request.user dari token terverifikasi', async () => {
    const request: Record<string, unknown> = { headers: { authorization: 'Bearer token-psikolog' } };
    await expect(guard.canActivate(ctx(Bebas, 'handler', request))).resolves.toBe(true);
    // Guard tim meneruskan opsi (izinkanPasswordSementara / izinkanSaatAkademikGangguan) ke verifikasi.
    expect(verifikasi).toHaveBeenCalledWith('token-psikolog', expect.any(Object));
    expect(request.user).toEqual(user('PSIKOLOG'));
  });

  it('meneruskan 401 token tidak valid dan 403 AKUN_TIDAK_AKTIF dari AccessTokenService', async () => {
    verifikasi.mockRejectedValueOnce(new UnauthorizedException('Token tidak valid'));
    await expect(guard.canActivate(ctx(Bebas, 'handler', { headers: { authorization: 'Bearer x' } })))
      .rejects.toBeInstanceOf(UnauthorizedException);
    verifikasi.mockRejectedValueOnce(new ForbiddenException('AKUN_TIDAK_AKTIF'));
    await expect(guard.canActivate(ctx(Bebas, 'handler', { headers: { authorization: 'Bearer x' } })))
      .rejects.toThrow('AKUN_TIDAK_AKTIF');
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const run = (cls: { prototype: object }, method: string, u?: AuthenticatedUser) =>
    guard.canActivate(ctx(cls, method, { user: u }));

  it('route tanpa @Roles mengizinkan semua role yang sudah terautentikasi', () => {
    for (const role of ['MAHASISWA', 'PSIKOLOG', 'DOSEN_ADMIN'] as const) expect(run(Bebas, 'handler', user(role))).toBe(true);
  });

  it('@Roles di controller: role cocok diizinkan, role lain 403', () => {
    expect(run(KhususPsikolog, 'handler', user('PSIKOLOG'))).toBe(true);
    for (const role of ['MAHASISWA', 'DOSEN_ADMIN'] as const) {
      expect(() => run(KhususPsikolog, 'handler', user(role))).toThrow(ForbiddenException);
    }
  });

  it('@Roles di handler menimpa @Roles controller', () => {
    expect(run(KhususPsikolog, 'khususAdmin', user('DOSEN_ADMIN'))).toBe(true);
    expect(() => run(KhususPsikolog, 'khususAdmin', user('PSIKOLOG'))).toThrow(ForbiddenException);
  });

  it('mendukung beberapa role sekaligus', () => {
    expect(run(MultiRole, 'handler', user('MAHASISWA'))).toBe(true);
    expect(run(MultiRole, 'handler', user('PSIKOLOG'))).toBe(true);
    expect(() => run(MultiRole, 'handler', user('DOSEN_ADMIN'))).toThrow(ForbiddenException);
  });

  it('menolak 403 bila route ber-role tetapi request.user tidak ada', () => {
    expect(() => run(KhususPsikolog, 'handler', undefined)).toThrow(ForbiddenException);
  });
});

describe('dekorator RBAC', () => {
  const reflector = new Reflector();

  it('@Roles menyimpan role unik dan menolak daftar kosong atau role tidak valid', () => {
    class X { @Roles(Role.PSIKOLOG, Role.PSIKOLOG, Role.DOSEN_ADMIN) h() { return 1; } }
    expect(reflector.get(ROLES_KEY, X.prototype.h)).toEqual(['PSIKOLOG', 'DOSEN_ADMIN']);
    expect(() => Roles()).toThrow('setidaknya satu role');
    expect(() => Roles('SUPERADMIN' as never)).toThrow('role yang valid');
  });

  it('@Public menandai metadata publik', () => {
    expect(reflector.get(IS_PUBLIC_KEY, Publik)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, Bebas)).toBeUndefined();
  });

  it('@CurrentUser mengembalikan request.user hasil verifikasi', () => {
    class X { h(@CurrentUser() _u: AuthenticatedUser) { return _u; } }
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, X, 'h') as Record<string, { factory: (d: unknown, c: ExecutionContext) => unknown }>;
    const factory = Object.values(meta)[0].factory;
    expect(factory(undefined, ctx(X, 'h', { user: user('MAHASISWA') }))).toEqual(user('MAHASISWA'));
  });
});
