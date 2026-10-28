import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
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

  beforeEach(() => {
    client = { query: jest.fn(), release: jest.fn() };
    pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
    encryption = { decrypt: jest.fn() };
    service = new AuthService(
      pool as unknown as Pool,
      jwt as unknown as JwtService,
      encryption as unknown as EncryptionService,
      { wajibAktif: jest.fn().mockResolvedValue({ aktif: true, sumber: 'api' }) } as never,
    );
    delete process.env.REFRESH_TOKEN_TTL_SECONDS;
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
        return {
          rows: [{
            id: 'old-row-id', role: 'MAHASISWA', id_pengguna: userId,
            token_family_id: familyId, expires_at: new Date(Date.now() + 60_000),
            revoked_at: new Date(), replaced_by: 'new-row-id',
          }],
        };
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
});
