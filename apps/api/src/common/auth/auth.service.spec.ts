import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, createHmac } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { EncryptionService } from '../crypto/encryption.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const userId = '4ce31f67-5c86-4ef7-a565-d61ca9cd2ecb';
  const familyId = '555e8e8f-5170-40ea-9d8a-6264016ef86f';
  let service: AuthService;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let jwt: { signAsync: jest.Mock };
  let encryption: { decrypt: jest.Mock };
  let akademik: { wajibAktif: jest.Mock; verifikasi: jest.Mock };
  let redis: { status: string; set: jest.Mock };
  let lockout: { pastikanTidakTerkunci: jest.Mock; catatGagal: jest.Mock; reset: jest.Mock };
  let audit: { catat: jest.Mock };

  const refreshRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'old-row-id', role: 'MAHASISWA', id_pengguna: userId,
    token_family_id: familyId, expires_at: new Date(Date.now() + 60_000),
    revoked_at: null, replaced_by: null, ...overrides,
  });

  beforeEach(() => {
    client = { query: jest.fn(), release: jest.fn() };
    pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
    encryption = { decrypt: jest.fn() };
    akademik = {
      wajibAktif: jest.fn().mockResolvedValue({ aktif: true, sumber: 'api' }),
      verifikasi: jest.fn().mockResolvedValue({ aktif: true, sumber: 'api' }),
    };
    redis = { status: 'ready', set: jest.fn().mockResolvedValue('OK') };
    lockout = {
      pastikanTidakTerkunci: jest.fn().mockResolvedValue(undefined),
      catatGagal: jest.fn().mockResolvedValue(1),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    // Pre-check status mahasiswa (di luar transaksi) default: tidak perlu re-verifikasi.
    pool.query.mockResolvedValue({ rows: [] });
    service = new AuthService(
      pool as unknown as Pool,
      jwt as unknown as JwtService,
      encryption as unknown as EncryptionService,
      akademik as never,
      redis as never,
      { terbitkan: jest.fn().mockResolvedValue('mfa-setup-token') } as never,
      lockout as never,
      audit as never,
    );
    delete process.env.REFRESH_TOKEN_TTL_SECONDS;
    delete process.env.REFRESH_REUSE_GRACE_SECONDS;
    delete process.env.STAFF_MFA_REQUIRED;
  });

  it('rejects a missing refresh token before querying the database', async () => {
    await expect(service.refresh(undefined, '127.0.0.1', 'test-agent'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects staff accounts without a stored password hash', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(service.loginStaff(
      'DOSEN_ADMIN', 'ADMIN@example.edu', 'password', undefined, undefined, undefined,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM dosen_admin'), [
      'admin@example.edu',
    ]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects valid credentials for an inactive staff account', async () => {
    const hash = await argon2.hash('correct horse battery staple');
    pool.query.mockResolvedValue({
      rows: [{ id: userId, password_hash: hash, aktif: false, mfa_secret_enc: null }],
    });

    await expect(service.loginStaff(
      'PSIKOLOG', 'psy@example.edu', 'correct horse battery staple', undefined, undefined, undefined,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('issues a staff session and stores only a hash of its refresh token', async () => {
    const password = 'correct horse battery staple';
    const hash = await argon2.hash(password);
    pool.query.mockResolvedValue({
      rows: [{ id: userId, password_hash: hash, aktif: true, mfa_secret_enc: null }],
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO refresh_token')) return { rows: [{ id: 'refresh-row-id' }] };
      return { rows: [] };
    });

    const session = await service.loginStaff(
      'DOSEN_ADMIN', ' ADMIN@example.edu ', password, undefined, '127.0.0.1', 'test-agent',
    );

    expect(session.user).toEqual({ id: userId, role: 'DOSEN_ADMIN' });
    expect(session.accessToken).toBe('signed-access-token');
    expect(session.refreshToken).toHaveLength(43);
    expect(session.expiresIn).toBe(900);
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_token'));
    expect(insert[1][2]).toBe(createHash('sha256').update(session.refreshToken).digest('hex'));
    expect(insert[1]).not.toContain(session.refreshToken);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rotates a valid refresh token in the same family', async () => {
    const oldToken = 'old-refresh-token';
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text, role')) {
        return {
          rows: [{
            id: 'old-row-id', role: 'MAHASISWA', id_pengguna: userId,
            token_family_id: familyId, expires_at: new Date(Date.now() + 60_000),
            revoked_at: null, replaced_by: null,
          }],
        };
      }
      if (sql.includes('SELECT 1 FROM mahasiswa')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO refresh_token')) return { rows: [{ id: 'new-row-id' }] };
      return { rows: [] };
    });

    const next = await service.refresh(oldToken, '127.0.0.1', 'test-agent');

    expect(next.user).toEqual({ id: userId, role: 'MAHASISWA' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET revoked_at = now(), replaced_by = $2'),
      ['old-row-id', 'new-row-id'],
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('revokes the family when a rotated refresh token is reused', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text, role')) {
        // Di luar grace window: rotasi terjadi 1 menit lalu.
        return { rows: [refreshRow({ revoked_at: new Date(Date.now() - 60_000), replaced_by: 'new-row-id' })] };
      }
      return { rows: [] };
    });

    await expect(service.refresh('reused-refresh-token', undefined, undefined))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE token_family_id = $1'), [familyId],
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('allows a parallel refresh with the just-rotated token inside the grace window', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text, role')) {
        return { rows: [refreshRow({ revoked_at: new Date(Date.now() - 2_000), replaced_by: 'next-row-id' })] };
      }
      if (sql.includes('SELECT revoked_at FROM refresh_token')) return { rows: [{ revoked_at: null }] };
      if (sql.includes('SELECT 1 FROM mahasiswa')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('INSERT INTO refresh_token')) return { rows: [{ id: 'sibling-row-id' }] };
      return { rows: [] };
    });

    const next = await service.refresh('old-refresh-token', undefined, undefined);

    expect(next.user).toEqual({ id: userId, role: 'MAHASISWA' });
    const revokingFamily = client.query.mock.calls.some(([sql]) => sql.includes('WHERE token_family_id = $1'));
    expect(revokingFamily).toBe(false);
    const markingReplaced = client.query.mock.calls.some(([sql]) => sql.includes('replaced_by = $2'));
    expect(markingReplaced).toBe(false);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('treats grace-window reuse as theft once the successor was revoked', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text, role')) {
        return { rows: [refreshRow({ revoked_at: new Date(Date.now() - 2_000), replaced_by: 'next-row-id' })] };
      }
      if (sql.includes('SELECT revoked_at FROM refresh_token')) return { rows: [{ revoked_at: new Date() }] };
      return { rows: [] };
    });

    await expect(service.refresh('old-refresh-token', undefined, undefined))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE token_family_id = $1'), [familyId],
    );
  });

  it('re-verifies a stale student status before opening the DB transaction', async () => {
    pool.query.mockResolvedValue({ rows: [{ nim: '12345678', terakhir_verifikasi_at: null }] });
    akademik.verifikasi.mockResolvedValue({ aktif: false, sumber: 'api' });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text, role')) return { rows: [refreshRow()] };
      if (sql.includes('SELECT 1 FROM mahasiswa')) return { rowCount: 1, rows: [{}] };
      return { rows: [] };
    });

    await expect(service.refresh('old-refresh-token', undefined, undefined))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(akademik.verifikasi).toHaveBeenCalledWith('12345678');
    expect(akademik.verifikasi.mock.invocationCallOrder[0])
      .toBeLessThan(pool.connect.mock.invocationCallOrder[0]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE token_family_id = $1'), [familyId],
    );
  });

  it('requires MFA for staff in production when no secret is enrolled', async () => {
    const password = 'correct horse battery staple';
    const hash = await argon2.hash(password);
    pool.query.mockResolvedValue({
      rows: [{ id: userId, password_hash: hash, aktif: true, mfa_secret_enc: null }],
    });
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const error = await service.loginStaff('PSIKOLOG', 'psy@example.edu', password, undefined, undefined, undefined)
        .catch((e) => e);
      expect(error.getStatus()).toBe(403);
      // Password sudah terbukti: staf menerima token sekali pakai untuk mendaftarkan MFA.
      expect(error.getResponse()).toEqual(expect.objectContaining({ kode: 'MFA_WAJIB', mfa_setup_token: 'mfa-setup-token' }));
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('records failed staff logins for lockout and audit without the email, and resets on success', async () => {
    const hash = await argon2.hash('correct horse battery staple');
    pool.query.mockResolvedValue({ rows: [{ id: userId, password_hash: hash, aktif: true, mfa_secret_enc: null }] });
    await expect(service.loginStaff('PSIKOLOG', 'psy@example.edu', 'salah', undefined, '1.2.3.4', 'ua'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(lockout.catatGagal).toHaveBeenCalledWith('PSIKOLOG', 'psy@example.edu');
    const entry = audit.catat.mock.calls[0][0];
    expect(entry).toMatchObject({ aksi: 'LOGIN_GAGAL', resourceId: userId, hasil: 'DITOLAK', ip: '1.2.3.4' });
    expect(JSON.stringify(entry)).not.toContain('psy@example.edu');
    expect(lockout.reset).not.toHaveBeenCalled();

    client.query.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO refresh_token') ? { rows: [{ id: 'r' }] } : { rows: [] });
    await service.loginStaff('PSIKOLOG', 'psy@example.edu', 'correct horse battery staple', undefined, undefined, undefined);
    expect(lockout.reset).toHaveBeenCalledWith('PSIKOLOG', 'psy@example.edu');
  });

  it('refuses locked accounts before checking the password', async () => {
    lockout.pastikanTidakTerkunci.mockRejectedValue(new Error('AKUN_TERKUNCI_SEMENTARA'));
    await expect(service.loginStaff('PSIKOLOG', 'psy@example.edu', 'x', undefined, undefined, undefined))
      .rejects.toThrow('AKUN_TERKUNCI_SEMENTARA');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a replayed TOTP code', async () => {
    const password = 'correct horse battery staple';
    const hash = await argon2.hash(password);
    const secretBase32 = 'JBSWY3DPEHPK3PXP';
    pool.query.mockResolvedValue({
      rows: [{ id: userId, password_hash: hash, aktif: true, mfa_secret_enc: Buffer.from('x') }],
    });
    encryption.decrypt.mockReturnValue(Buffer.from(secretBase32));
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO refresh_token')) return { rows: [{ id: 'refresh-row-id' }] };
      return { rows: [] };
    });
    const otp = totp(secretBase32, Math.floor(Date.now() / 30_000));

    await expect(service.loginStaff('DOSEN_ADMIN', 'a@example.edu', password, otp, undefined, undefined))
      .resolves.toMatchObject({ user: { id: userId, role: 'DOSEN_ADMIN' } });

    redis.set.mockResolvedValue(null); // time-step sudah ditandai terpakai
    await expect(service.loginStaff('DOSEN_ADMIN', 'a@example.edu', password, otp, undefined, undefined))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('auth:totp:used:DOSEN_ADMIN:' + userId + ':'), '1', 'EX', 90, 'NX',
    );
  });

  describe('gantiPasswordStaf', () => {
    const lama = 'password-lama-123';
    const staf = { id: userId, role: 'PSIKOLOG' as const };

    beforeEach(async () => {
      const hash = await argon2.hash(lama);
      pool.query.mockResolvedValue({ rows: [{ password_hash: hash }] });
      client.query.mockResolvedValue({ rows: [] });
    });

    it('replaces the hash, clears the temporary-password flag and revokes all sessions', async () => {
      await service.gantiPasswordStaf(staf, lama, 'password-baru-456');
      const update = client.query.mock.calls.find(([sql]) => String(sql).includes('SET password_hash = $2'))!;
      expect(update[0]).toContain('UPDATE psikolog');
      expect(update[0]).toContain('wajib_ganti_password = false');
      await expect(argon2.verify(update[1][1], 'password-baru-456')).resolves.toBe(true);
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE refresh_token'), [userId, 'PSIKOLOG']);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    it('rejects a wrong current password, an unchanged password and students', async () => {
      await expect(service.gantiPasswordStaf(staf, 'salah-salah-salah', 'password-baru-456'))
        .rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.gantiPasswordStaf(staf, lama, lama)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.gantiPasswordStaf({ id: userId, role: 'MAHASISWA' }, lama, 'password-baru-456'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('uses the dosen_admin table for admins', async () => {
      await service.gantiPasswordStaf({ id: userId, role: 'DOSEN_ADMIN' }, lama, 'password-baru-456');
      expect(pool.query.mock.calls[0][0]).toContain('FROM dosen_admin WHERE id_dosen = $1');
    });
  });
});

function totp(base32: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
