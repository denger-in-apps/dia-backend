import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import { Pool } from 'pg';
import { RuangSesiService } from './ruang-sesi.service';

describe('RuangSesiService (E2EE)', () => {
  const mhs = { id: '11111111-1111-4111-8111-111111111111', role: 'MAHASISWA' as const };
  const psi = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const admin = { id: '33333333-3333-4333-8333-333333333333', role: 'DOSEN_ADMIN' as const };
  const idSesi = '44444444-4444-4444-8444-444444444444';
  const sesi = {
    id_sesi: idSesi, id_mahasiswa: mhs.id, id_psikolog: psi.id, status_sesi: 'BERLANGSUNG',
    waktu_mulai: new Date(), waktu_selesai: new Date(),
  };
  const spki = (type: 'ec' | 'x25519' | 'rsa') => {
    const options = type === 'ec' ? { namedCurve: 'prime256v1' } : type === 'rsa' ? { modulusLength: 2048 } : {};
    const { publicKey } = generateKeyPairSync(type as 'ec', options as { namedCurve: string });
    return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  };
  const ciphertext = Buffer.alloc(48, 7).toString('base64');
  const nonce = Buffer.alloc(12, 1).toString('base64');

  let pool: { query: jest.Mock };
  let service: RuangSesiService;

  beforeEach(() => {
    pool = { query: jest.fn().mockResolvedValue({ rows: [sesi] }) };
    service = new RuangSesiService(pool as unknown as Pool);
  });

  it('scopes session access to its own participant column and hides other sessions with 404', async () => {
    await service.pastikanPeserta(mhs, idSesi);
    expect(pool.query.mock.calls[0][0]).toContain('id_mahasiswa = $2');
    await service.pastikanPeserta(psi, idSesi);
    expect(pool.query.mock.calls[1][0]).toContain('id_psikolog = $2');
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.pastikanPeserta(mhs, idSesi)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.pastikanPeserta(admin, idSesi)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to join finished sessions', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...sesi, status_sesi: 'SELESAI' }] });
    const error = await service.pastikanBolehGabung(mhs, idSesi).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().kode).toBe('SESI_SUDAH_BERAKHIR');
  });

  it.each(['ec', 'x25519'] as const)('accepts and upserts a %s SPKI public key with a fingerprint', async (type) => {
    pool.query.mockResolvedValue({ rows: [{ dibuat_at: new Date() }] });
    const key = spki(type);
    const hasil = await service.simpanKunci(mhs, key);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (id_pengguna, role) DO UPDATE');
    expect(params).toEqual([mhs.id, 'MAHASISWA', Buffer.from(key, 'base64')]);
    expect(hasil.kunci_publik).toBe(key);
    expect(hasil.sidik_jari).toMatch(/^([0-9A-F]{4} ){15}[0-9A-F]{4}$/);
  });

  it.each([
    ['an RSA key', () => spki('rsa')],
    ['random bytes', () => Buffer.alloc(65, 4).toString('base64')],
    ['non-canonical base64', () => 'abc'],
  ])('rejects %s as public key', async (_label, key) => {
    await expect(service.simpanKunci(mhs, key())).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns the counterpart's key: psychologist for students and vice versa", async () => {
    const key = Buffer.from(spki('ec'), 'base64');
    pool.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM kunci_e2ee') ? { rows: [{ kunci_publik: key, dibuat_at: new Date() }] } : { rows: [sesi] });
    const untukMhs = await service.kunciLawan(mhs, idSesi);
    expect(untukMhs.role).toBe('PSIKOLOG');
    expect(pool.query.mock.calls[1][1]).toEqual([psi.id, 'PSIKOLOG']);
    const untukPsi = await service.kunciLawan(psi, idSesi);
    expect(untukPsi.role).toBe('MAHASISWA');
    expect(pool.query.mock.calls[3][1]).toEqual([mhs.id, 'MAHASISWA']);
  });

  it('reports a missing counterpart key with a clear code', async () => {
    pool.query.mockImplementation(async (sql: string) => (sql.includes('FROM kunci_e2ee') ? { rows: [] } : { rows: [sesi] }));
    const error = await service.kunciLawan(mhs, idSesi).catch((e) => e);
    expect(error.getResponse().kode).toBe('KUNCI_LAWAN_BELUM_ADA');
  });

  it('stores only ciphertext, atomically conditioned on a running session of the sender', async () => {
    const created = new Date();
    pool.query.mockResolvedValue({
      rows: [{ id_pesan: 'p1', id_sesi: idSesi, pengirim: 'MAHASISWA', ciphertext: Buffer.from(ciphertext, 'base64'),
        nonce: Buffer.from(nonce, 'base64'), created_at: created }],
    });
    const pesan = await service.kirimPesan(mhs, idSesi, ciphertext, nonce);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO sesi_pesan');
    expect(sql).toContain("s.id_mahasiswa = $2 AND s.status_sesi = 'BERLANGSUNG'");
    expect(params).toEqual([idSesi, mhs.id, 'MAHASISWA', Buffer.from(ciphertext, 'base64'), Buffer.from(nonce, 'base64')]);
    expect(pesan).toEqual({ id_pesan: 'p1', id_sesi: idSesi, pengirim: 'MAHASISWA', ciphertext, nonce, created_at: created });
  });

  it.each([
    ['DIJADWALKAN', ConflictException, 'SESI_BELUM_DIMULAI'],
    ['SELESAI', ForbiddenException, 'SESI_SUDAH_BERAKHIR'],
  ])('explains why a message was not stored when the session is %s', async (status, type, kode) => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...sesi, status_sesi: status }] });
    const error = await service.kirimPesan(psi, idSesi, ciphertext, nonce).catch((e) => e);
    expect(error).toBeInstanceOf(type);
    expect(error.getResponse().kode).toBe(kode);
  });

  it.each([
    ['too short nonce', ciphertext, Buffer.alloc(8).toString('base64')],
    ['oversized ciphertext', Buffer.alloc(16 * 1024 + 1).toString('base64'), nonce],
  ])('rejects %s', async (_label, c, n) => {
    await expect(service.kirimPesan(mhs, idSesi, c, n)).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('lists ciphertext after a cursor only for participants', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [sesi] })
      .mockResolvedValueOnce({ rows: [] });
    await service.daftarPesan(psi, idSesi, '2026-12-01T09:00:00+07:00', 20);
    expect(pool.query.mock.calls[1][1]).toEqual([idSesi, '2026-12-01T09:00:00+07:00', 20]);
  });
});
