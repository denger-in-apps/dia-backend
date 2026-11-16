import { HttpException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { KonfigurasiSosService } from '../eskalasi/konfigurasi-sos.service';
import { CurhatService } from './curhat.service';

describe('CurhatService — mahasiswa (SCRUM-260)', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  let encryption: EncryptionService;
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let jumlahJamIni: number;
  let service: CurhatService;

  beforeAll(() => {
    process.env.ENCRYPTION_ACTIVE_KEY_ID = 'test';
    process.env.ENCRYPTION_KEY_test = randomBytes(32).toString('base64');
    encryption = new EncryptionService();
  });

  beforeEach(() => {
    jumlahJamIni = 0;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('count(*)::int')) return { rows: [{ jumlah: jumlahJamIni }] };
        if (sql.includes('INSERT INTO curhat_anonim')) {
          return {
            rows: [{
              id_curhat: params[0], waktu_curhat: new Date(), status: 'BARU', alias_anonim: params[2],
              isi_curhat_enc: params[1], jumlah_balasan: 0,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    service = new CurhatService(
      pool as unknown as Pool, encryption,
      { ambil: jest.fn().mockResolvedValue({ hotline_label: 'Healing119.id — 119 ext. 8', hotline_aktif: true }) } as unknown as KonfigurasiSosService,
    );
  });

  const insert = () => client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO curhat_anonim'))!;

  it('derives a stable, non-reversible alias per student', () => {
    const alias = service.aliasAnonim(idMhs);
    expect(alias).toMatch(/^Anonim-[0-9A-F]{6}$/);
    expect(service.aliasAnonim(idMhs)).toBe(alias);
    expect(service.aliasAnonim('22222222-2222-4222-8222-222222222222')).not.toBe(alias);
  });

  it('stores the message encrypted with the alias and always returns help info', async () => {
    const hasil = await service.kirim(idMhs, 'Aku merasa sendirian');
    const [, params] = insert();
    expect(params[1].toString('utf8')).not.toContain('sendirian');
    expect(encryption.decrypt(params[1], `curhat_anonim:isi_curhat_enc:${params[0]}`).toString()).toBe('Aku merasa sendirian');
    expect(params[2]).toBe(service.aliasAnonim(idMhs));
    expect(hasil).toMatchObject({ isi: 'Aku merasa sendirian', status: 'BARU', bantuan: { hotline: { aktif: true } } });
    expect(hasil).not.toHaveProperty('isi_curhat_enc');
  });

  it('limits messages per hour (with help info) under a per-student lock', async () => {
    jumlahJamIni = 10;
    const error = await service.kirim(idMhs, 'x').catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse().detail.bantuan.hotline.label).toContain('119');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [`curhat:${idMhs}`]);
    expect(insert()).toBeUndefined();
  });

  it('shows own curhat with decrypted replies; others get 404', async () => {
    const id = 'c1';
    const isiEnc = encryption.encrypt('isi', `curhat_anonim:isi_curhat_enc:${id}`);
    const balasanEnc = encryption.encrypt('saran psikolog', 'curhat_balasan:isi_enc:b1');
    pool.query
      .mockResolvedValueOnce({ rows: [{ id_curhat: id, status: 'DIJAWAB', alias_anonim: 'Anonim-ABCDEF', isi_curhat_enc: isiEnc, jumlah_balasan: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id_balasan: 'b1', isi_enc: balasanEnc, waktu: new Date(), nama_psikolog: 'Psi A' }] });
    const detail = await service.detail(idMhs, id);
    expect(pool.query.mock.calls[0][1]).toEqual([id, idMhs]);
    expect(detail.isi).toBe('isi');
    expect(detail.balasan[0]).toMatchObject({ isi: 'saran psikolog', nama_psikolog: 'Psi A' });
    expect(detail.balasan[0]).not.toHaveProperty('isi_enc');

    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.detail(idMhs, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes only own curhat', async () => {
    pool.query.mockResolvedValue({ rowCount: 0 });
    await expect(service.hapus(idMhs, 'c1')).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query.mock.calls[0][1]).toEqual(['c1', idMhs]);
  });
});
