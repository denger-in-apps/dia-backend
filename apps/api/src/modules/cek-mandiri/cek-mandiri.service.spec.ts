import { HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { KonfigurasiSosService } from '../eskalasi/konfigurasi-sos.service';
import { CekMandiriService } from './cek-mandiri.service';

describe('CekMandiriService (PBI-15)', () => {
  const idMhs = '11111111-1111-4111-8111-111111111111';
  const tPhq = '66666666-6666-4666-8666-666666666666';
  const tGad = '77777777-7777-4777-8777-777777777777';
  const phqRendah = [0, 1, 0, 1, 0, 0, 1, 0, 0];
  let pool: { query: jest.Mock; connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let templates: unknown[];
  let jumlahHariIni: number;
  let service: CekMandiriService;

  beforeEach(() => {
    templates = [
      { id_template: tPhq, kode: 'PHQ9', jumlah_butir: 9 },
      { id_template: tGad, kode: 'GAD7', jumlah_butir: 7 },
    ];
    jumlahHariIni = 0;
    client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('count(*)::int')) return { rows: [{ jumlah: jumlahHariIni }] };
        if (sql.includes('INSERT INTO hasil_cek_mandiri')) {
          return {
            rows: [{
              id_cek: params[0], waktu_tes: new Date(), skor_phq9: params[1], skor_gad7: params[2],
              risiko_phq9: params[3], risiko_gad7: params[4], butir9_positif: params[5],
            }],
          };
        }
        return { rows: [] };
      }),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql: string) => (sql.includes('jsonb_array_length') ? { rows: templates } : { rows: [] })),
    };
    encryption = { encrypt: jest.fn(() => Buffer.from('enc')), decrypt: jest.fn() };
    service = new CekMandiriService(
      pool as unknown as Pool,
      encryption as unknown as EncryptionService,
      { ambil: jest.fn().mockResolvedValue({ hotline_label: 'Healing119.id — 119 ext. 8', hotline_aktif: true }) } as unknown as KonfigurasiSosService,
    );
  });

  const insert = () => client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO hasil_cek_mandiri'))!;

  it('scores on the server, stores answers encrypted bound to the row, and returns a non-diagnostic result', async () => {
    const hasil = await service.kirim(idMhs, {
      id_template_phq9: tPhq, jawaban_phq9: phqRendah, id_template_gad7: tGad, jawaban_gad7: [2, 2, 2, 2, 2, 0, 0],
    });
    const params = insert()[1];
    expect(params.slice(1, 6)).toEqual([3, 10, 'MINIMAL', 'SEDANG', false]);
    expect(params[7]).toBe('KONSELING');
    expect(encryption.encrypt).toHaveBeenCalledWith(
      JSON.stringify({ phq9: phqRendah, gad7: [2, 2, 2, 2, 2, 0, 0] }),
      `hasil_cek_mandiri:jawaban_enc:${params[0]}`,
    );
    expect(hasil).toMatchObject({
      phq9: { skor: 3, skor_maks: 27, tingkat: 'MINIMAL' },
      gad7: { skor: 10, skor_maks: 21, tingkat: 'SEDANG' },
      jalur_bantuan_segera: false,
      hotline: null,
      disclaimer: expect.stringContaining('bukan diagnosis'),
    });
  });

  it('flags PHQ-9 item 9 and includes the configured hotline', async () => {
    const hasil = await service.kirim(idMhs, { id_template_phq9: tPhq, jawaban_phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] });
    expect(insert()[1][5]).toBe(true);
    expect(hasil.jalur_bantuan_segera).toBe(true);
    expect(hasil.hotline).toEqual({ label: 'Healing119.id — 119 ext. 8', aktif: true });
  });

  it.each([
    [{}, 'JAWABAN_KOSONG'],
    [{ jawaban_phq9: phqRendah }, 'PASANGAN_TIDAK_LENGKAP'],
    [{ id_template_phq9: tPhq, jawaban_phq9: [0, 1] }, 'JUMLAH_JAWABAN_TIDAK_SESUAI'],
    [{ id_template_phq9: tGad, jawaban_phq9: phqRendah }, 'TEMPLATE_TIDAK_VALID'],
  ])('rejects invalid submissions %j', async (dto, kode) => {
    const error = await service.kirim(idMhs, dto).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse().kode).toBe(kode);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('limits submissions per 24 hours under a per-student lock', async () => {
    jumlahHariIni = 20;
    const error = await service.kirim(idMhs, { id_template_phq9: tPhq, jawaban_phq9: phqRendah }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [`cek-mandiri:${idMhs}`]);
    expect(insert()).toBeUndefined();
  });

  it('shows detail with decrypted answers only for the owner', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id_cek: 'c1', skor_phq9: 3, skor_gad7: null, risiko_phq9: 'MINIMAL', risiko_gad7: null,
        butir9_positif: false, jawaban_enc: Buffer.from('enc') }],
    });
    encryption.decrypt.mockReturnValue(Buffer.from(JSON.stringify({ phq9: phqRendah, gad7: null })));
    const detail = await service.detail(idMhs, 'c1');
    expect(pool.query.mock.calls[0][1]).toEqual(['c1', idMhs]);
    expect(detail.jawaban).toEqual({ phq9: phqRendah, gad7: null });
    expect(encryption.decrypt).toHaveBeenCalledWith(Buffer.from('enc'), 'hasil_cek_mandiri:jawaban_enc:c1');

    pool.query.mockResolvedValue({ rows: [] });
    await expect(service.detail(idMhs, 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes only own results', async () => {
    pool.query.mockResolvedValue({ rowCount: 0 });
    await expect(service.hapus(idMhs, 'c1')).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query.mock.calls[0][1]).toEqual(['c1', idMhs]);
  });
});
