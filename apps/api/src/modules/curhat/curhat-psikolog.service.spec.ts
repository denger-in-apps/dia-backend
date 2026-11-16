import { NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { AuditService } from '../../common/audit/audit.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { CurhatPsikologService } from './curhat-psikolog.service';
import { CurhatService } from './curhat.service';

describe('CurhatPsikologService (SCRUM-261)', () => {
  const psi = { id: '22222222-2222-4222-8222-222222222222', role: 'PSIKOLOG' as const };
  const id = '88888888-8888-4888-8888-888888888888';
  let encryption: EncryptionService;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let audit: { catat: jest.Mock };
  let curhat: { balasan: jest.Mock };
  let service: CurhatPsikologService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
  });

  beforeEach(() => {
    const row = { id_curhat: id, status: 'BARU', alias_anonim: 'Anonim-ABCDEF', jumlah_balasan: 0,
      isi_curhat_enc: encryption.encrypt('isi curhat', `curhat_anonim:isi_curhat_enc:${id}`) };
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SET status = 'DIJAWAB'")) return { rows: [{}], rowCount: 1 };
        if (sql.includes('INSERT INTO curhat_balasan')) return { rows: [{ waktu: new Date() }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM v_curhat_untuk_psikolog')) return { rows: [{ ...row }] };
        if (sql.includes('FROM psikolog')) return { rows: [{ nama: 'Psi A' }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    audit = { catat: jest.fn() };
    curhat = { balasan: jest.fn().mockResolvedValue([]) };
    service = new CurhatPsikologService(
      pool as unknown as Pool, encryption, audit as unknown as AuditService, curhat as unknown as CurhatService,
    );
  });

  it('reads only through the identity-free view and audits the list read', async () => {
    const daftar = await service.daftar(psi, { status: 'BARU' }, {});
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM v_curhat_untuk_psikolog v');
    expect(sql).not.toContain('id_mahasiswa');
    expect(params).toEqual(['BARU', 50]);
    expect(daftar[0]).toEqual(expect.objectContaining({ isi: 'isi curhat', alias_anonim: 'Anonim-ABCDEF' }));
    expect(daftar[0]).not.toHaveProperty('id_mahasiswa');
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'CURHAT_READ', metadata: expect.objectContaining({ jumlah: 1 }) }));
  });

  it('marks a new curhat as read when opened, audited per item', async () => {
    const detail = await service.detail(psi, id, { ip: '1.1.1.1' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'DIBACA'"), [id]);
    expect(detail.status).toBe('DIBACA');
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'CURHAT_READ', resourceId: id }));
    expect(curhat.balasan).toHaveBeenCalledWith(id);
  });

  it('replies encrypted, marks DIJAWAB, notifies the student without leaking identity or content', async () => {
    const balasan = await service.balas(psi, id, 'Coba tarik napas pelan', {});
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO curhat_balasan'))!;
    const [idBalasan, , idPsi, enc] = insert[1];
    expect(idPsi).toBe(psi.id);
    expect(encryption.decrypt(enc, `curhat_balasan:isi_enc:${idBalasan}`).toString()).toBe('Coba tarik napas pelan');
    const notif = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notifikasi'))!;
    expect(notif[0]).toContain("'CURHAT_DIJAWAB'");
    expect(notif[0]).not.toContain('isi');
    expect(audit.catat).toHaveBeenCalledWith(expect.objectContaining({ aksi: 'CURHAT_BALAS', resourceId: id }), client);
    expect(balasan).toEqual(expect.objectContaining({ isi: 'Coba tarik napas pelan', nama_psikolog: 'Psi A' }));
    expect(balasan).not.toHaveProperty('id_mahasiswa');
  });

  it('returns 404 for unknown curhat', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.detail(psi, id, {})).rejects.toBeInstanceOf(NotFoundException);
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(service.balas(psi, id, 'x', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.catat).not.toHaveBeenCalled();
  });
});
