export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Opsi cookie refresh token; dipakai saat set dan clear agar atributnya identik. */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: process.env.REFRESH_COOKIE_SAME_SITE === 'none' ? ('none' as const) : ('lax' as const),
    path: '/api/v1/auth',
  };
}
