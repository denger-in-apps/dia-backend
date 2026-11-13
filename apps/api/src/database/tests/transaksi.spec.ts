import { Pool } from 'pg';
import { denganTransaksi } from '../transaksi';

describe('denganTransaksi', () => {
  const buat = (rollbackGagal = false) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql === 'ROLLBACK' && rollbackGagal) throw new Error('koneksi putus');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    return { client, pool: { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool };
  };

  it('commits and releases the client', async () => {
    const { client, pool } = buat();
    await expect(denganTransaksi(pool, async () => 'ok')).resolves.toBe('ok');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back and rethrows the original error', async () => {
    const { client, pool } = buat();
    await expect(denganTransaksi(pool, async () => { throw new Error('asli'); })).rejects.toThrow('asli');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('keeps the original error when ROLLBACK fails and discards the broken client', async () => {
    const { client, pool } = buat(true);
    await expect(denganTransaksi(pool, async () => { throw new Error('asli'); })).rejects.toThrow('asli');
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'koneksi putus' }));
  });
});
