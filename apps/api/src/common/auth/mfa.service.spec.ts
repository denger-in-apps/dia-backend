import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../crypto/encryption.service';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { MfaTokenService } from './mfa-token.service';
import { cocokkanTotp, decodeBase32, encodeBase32, kodeTotp, otpauthUrl } from './totp';

describe('TOTP helper', () => {
  it('matches RFC 6238 SHA-1 test vectors (8 digit truncated to 6)', () => {
    // RFC 6238 Appendix B, secret "12345678901234567890", T=59 → 94287082; 6 digit = 287082.
    const secret = Buffer.from('12345678901234567890');
    expect(kodeTotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(kodeTotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('round-trips base32 and accepts ±1 step drift only', () => {
    const raw = randomBytes(20);
    const b32 = encodeBase32(raw);
    expect(decodeBase32(b32)).toEqual(raw);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(cocokkanTotp(b32, kodeTotp(raw, step - 1), now)).toBe(step - 1);
    expect(cocokkanTotp(b32, kodeTotp(raw, step - 2), now)).toBeNull();
    expect(cocokkanTotp(b32, '12a456', now)).toBeNull();
  });

  it('builds an otpauth URL for authenticator apps', () => {
    expect(otpauthUrl('ABC', 'psi@kampus.ac.id')).toBe(
      'otpauth://totp/Denger.in%3Apsi%40kampus.ac.id?secret=ABC&issuer=Denger.in&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('MfaService (SCRUM-208)', () => {
  const user = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  let encryption: EncryptionService;
  let pool: { query: jest.Mock };
  let redis: { status: string; set: jest.Mock; get: jest.Mock; del: jest.Mock; store: Map<string, string> };
  let auth: { consumeTotpStep: jest.Mock; terbitkanSesiStaf: jest.Mock };
  let akun: { email: string; ada_mfa: boolean } | null;
  let service: MfaService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
  });

  beforeEach(() => {
    akun = { email: 'psi@kampus.ac.id', ada_mfa: false };
    pool = {
      query: jest.fn(async (sql: string) =>
        sql.startsWith('SELECT') ? { rows: akun ? [akun] : [] } : { rows: [], rowCount: 1 }),
    };
    const store = new Map<string, string>();
    redis = {
      status: 'ready', store,
      set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
    };
    auth = {
      consumeTotpStep: jest.fn().mockResolvedValue(true),
      terbitkanSesiStaf: jest.fn().mockResolvedValue({ accessToken: 'a' }),
    };
    service = new MfaService(
      pool as unknown as Pool, redis as never, encryption,
      { verifikasi: jest.fn().mockResolvedValue(user), terbitkan: jest.fn() } as unknown as MfaTokenService,
      auth as unknown as AuthService,
    );
  });

  it('enrolls: pending secret is stored encrypted, the first OTP activates MFA and issues a session', async () => {
    const mulai = await service.mulai('setup');
    expect(mulai.otpauth_url).toContain('secret=' + mulai.secret);
    const [kunci, nilai, , ttl] = redis.set.mock.calls[0];
    expect(kunci).toBe(`auth:mfa:pending:PSIKOLOG:${user.id}`);
    expect(nilai).not.toContain(mulai.secret);
    expect(ttl).toBe(600);

    const otp = kodeTotp(decodeBase32(mulai.secret), Math.floor(Date.now() / 30_000));
    await expect(service.aktifkan('setup', otp, '1.1.1.1', 'ua')).resolves.toEqual({ accessToken: 'a' });

    const [sql, params] = pool.query.mock.calls.find(([s]) => String(s).startsWith('UPDATE'))!;
    expect(sql).toContain('mfa_secret_enc IS NULL');
    expect(encryption.decrypt(params[1], `psikolog:mfa_secret_enc:${user.id}`).toString()).toBe(mulai.secret);
    expect(auth.terbitkanSesiStaf).toHaveBeenCalledWith(user, '1.1.1.1', 'ua');
    expect(redis.store.size).toBe(0);
  });

  it('rejects a wrong or replayed OTP without storing the secret', async () => {
    await service.mulai('setup');
    await expect(service.aktifkan('setup', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pool.query.mock.calls.some(([s]) => String(s).startsWith('UPDATE'))).toBe(false);
  });

  it('requires starting enrollment first, and refuses accounts that already have MFA', async () => {
    const error = await service.aktifkan('setup', '123456').catch((e) => e);
    expect(error.getResponse().kode).toBe('MFA_BELUM_DIMULAI');
    akun = { email: 'psi@kampus.ac.id', ada_mfa: true };
    await expect(service.mulai('setup')).rejects.toBeInstanceOf(ConflictException);
    akun = null;
    await expect(service.mulai('setup')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed with 503 when Redis is unavailable', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    await expect(service.mulai('setup')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
