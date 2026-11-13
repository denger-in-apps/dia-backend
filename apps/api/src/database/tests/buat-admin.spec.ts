import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { buatAdmin, parseArgs } from '../seed/buat-admin';

describe('CLI admin:buat (SCRUM-208)', () => {
  it('parses arguments and validates required fields', () => {
    expect(parseArgs(['--np', '1980', '--nama', 'Dr. Siti', '--email', ' Siti@Kampus.ac.id '])).toEqual({
      np: '1980', nama: 'Dr. Siti', email: 'siti@kampus.ac.id', prodi: undefined, reset: false,
    });
    expect(parseArgs(['--email', 'a@b.id', '--reset'])).toMatchObject({ reset: true });
    expect(() => parseArgs(['--email', 'a@b.id'])).toThrow('--np dan --nama');
    expect(() => parseArgs(['--np', '1', '--nama', 'x', '--email', 'bukan-email'])).toThrow('--email');
    expect(() => parseArgs(['--email', 'a@b.id', '--role', 'x', '--reset'])).toThrow('tidak dikenal');
  });

  it('creates an active admin that must change the argon2id temporary password', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'adm' }] }) };
    const hasil = await buatAdmin(pool as unknown as Pool, { np: '1', nama: 'A', email: 'a@b.id' });
    expect(hasil).toEqual({ id: 'adm', password_sementara: expect.any(String), dibuat: true });
    expect(hasil.password_sementara).toHaveLength(24);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, true, true)');
    expect(params[4]).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(params[4], hasil.password_sementara)).toBe(true);
  });

  it('resets the password, reactivates and revokes old sessions', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'adm' }] }) };
    await buatAdmin(pool as unknown as Pool, { email: 'a@b.id', reset: true });
    expect(pool.query.mock.calls[0][0]).toContain('wajib_ganti_password = true, aktif = true');
    expect(pool.query.mock.calls[1]).toEqual([expect.stringContaining('UPDATE refresh_token'), ['adm']]);
  });

  it('explains duplicate accounts', async () => {
    const pool = { query: jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' })) };
    await expect(buatAdmin(pool as unknown as Pool, { np: '1', nama: 'A', email: 'a@b.id' })).rejects.toThrow('--reset');
  });
});
