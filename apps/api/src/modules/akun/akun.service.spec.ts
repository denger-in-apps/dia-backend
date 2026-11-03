import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AuditService } from '../../common/audit/audit.service';
import { AkunService, MAKS_KONTAK_DARURAT } from './akun.service';

describe('AkunService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  let encryption: EncryptionService;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let service: AkunService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
  });

  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
    pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: jest.fn().mockResolvedValue(client) };
    audit = { catat: jest.fn().mockResolvedValue(undefined) };
    service = new AkunService(pool as unknown as Pool, encryption, audit as unknown as AuditService);
  });

  const sqlCalls = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => String(sql));

  it('reads the profile scoped to the authenticated student and hides deleted accounts', async () => {
    await expect(service.profil(userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'), [userId]);
  });

  it('stores emergency phone numbers encrypted and bound to the row id', async () => {
    client.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('count(*)')) return { rows: [{ jumlah: 0 }], rowCount: 1 };
      if (sql.includes('INSERT INTO kontak_darurat')) {
        return {
          rows: [{ id: params[0], nama_kontak: params[1], no_telepon_enc: params[2], hubungan: params[3], created_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const kontak = await service.tambahKontak(userId, { nama_kontak: 'Ibu', no_telepon: '081234567890' });

    expect(kontak.no_telepon).toBe('081234567890');
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO kontak_darurat'))!;
    const [id, , ciphertext, , owner] = insert[1];
    expect(owner).toBe(userId);
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.toString('utf8')).not.toContain('081234567890');
    expect(encryption.decrypt(ciphertext, `kontak_darurat:no_telepon_enc:${id}`).toString()).toBe('081234567890');
    expect(() => encryption.decrypt(ciphertext, 'kontak_darurat:no_telepon_enc:other-id')).toThrow();
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it(`rejects more than ${MAKS_KONTAK_DARURAT} emergency contacts`, async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('count(*)')) return { rows: [{ jumlah: MAKS_KONTAK_DARURAT }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.tambahKontak(userId, { nama_kontak: 'X', no_telepon: '081234567890' }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(sqlCalls(client.query).some((sql) => sql.includes('INSERT'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('only updates or deletes contacts owned by the student', async () => {
    await expect(service.ubahKontak(userId, 'k1', { nama_kontak: 'Ayah' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id_kontak = $1 AND id_mahasiswa = $2'), ['k1', userId, 'Ayah'],
    );

    await expect(service.hapusKontak(userId, 'k1')).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE id_kontak = $1 AND id_mahasiswa = $2'), ['k1', userId],
    );
  });

  it('re-encrypts a changed phone number with the contact id as AAD', async () => {
    pool.query.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: [{ id: 'k1', nama_kontak: 'Ibu', no_telepon_enc: params[2], hubungan: null, created_at: new Date() }],
      rowCount: 1,
    }));
    const kontak = await service.ubahKontak(userId, 'k1', { no_telepon: '+628111111111' });
    expect(kontak.no_telepon).toBe('+628111111111');
  });

  it('exports owned data and records a DATA_EKSPOR audit entry', async () => {
    const enc = encryption.encrypt('0811', 'kontak_darurat:no_telepon_enc:k1');
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa')) return { rows: [{ id: userId, nim: '123' }], rowCount: 1 };
      if (sql.includes('FROM kontak_darurat')) {
        return { rows: [{ id: 'k1', nama_kontak: 'Ibu', no_telepon_enc: enc, hubungan: null, created_at: new Date() }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const data = await service.ekspor(userId, { ip: '127.0.0.1' });

    expect(data.profil.id).toBe(userId);
    expect(data.kontak_darurat[0].no_telepon).toBe('0811');
    for (const [, params] of pool.query.mock.calls) expect(params).toEqual([userId]);
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({
      aksi: 'DATA_EKSPOR', resourceId: userId, aktor: { id: userId, role: 'MAHASISWA' },
    }));
  });

  it('refuses account deletion while an SOS is still active', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa') && sql.includes('FOR UPDATE')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('FROM log_sos')) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.hapusAkun(userId, {})).rejects.toBeInstanceOf(ConflictException);
    expect(sqlCalls(client.query).some((sql) => sql.includes('deleted_at = now()'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('anonymizes the account, removes personal data, revokes sessions and audits atomically', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM mahasiswa') && sql.includes('FOR UPDATE')) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await service.hapusAkun(userId, { ip: '10.0.0.1', userAgent: 'ua' });

    const sql = sqlCalls(client.query).join('\n');
    for (const fragment of [
      'DELETE FROM kontak_darurat',
      'DELETE FROM preferensi_minat',
      'DELETE FROM curhat_anonim',
      'DELETE FROM keanggotaan_circle',
      'DELETE FROM kunci_e2ee',
      'koordinat_lokasi_enc = NULL',
      'jawaban_enc = NULL',
      'keluhan_awal_enc = NULL',
      "status_sesi = 'DIBATALKAN'",
      'UPDATE refresh_token SET revoked_at',
      "nama = 'Pengguna Dihapus'",
      'sso_subject = NULL',
      'deleted_at = now()',
    ]) {
      expect(sql).toContain(fragment);
    }
    for (const [statement, params] of client.query.mock.calls) {
      if (typeof statement === 'string' && params) expect(params).toEqual([userId]);
    }
    expect(audit.catat).toHaveBeenCalledWith(
      expect.objectContaining({ aksi: 'DATA_HAPUS', resourceId: userId }), client,
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('returns 404 when deleting an already deleted account', async () => {
    await expect(service.hapusAkun(userId, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
