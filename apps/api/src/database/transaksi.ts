import { Pool, PoolClient } from 'pg';

/**
 * Jalankan `work` dalam satu transaksi (BEGIN/COMMIT, ROLLBACK bila gagal).
 * Kegagalan ROLLBACK (mis. koneksi putus) tidak menutupi error asli; klien selalu dilepas,
 * dan klien yang rusak dibuang dari pool agar tidak dipakai ulang.
 */
export async function denganTransaksi<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let rusak: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      rusak = rollbackError as Error;
    }
    throw error;
  } finally {
    client.release(rusak);
  }
}
