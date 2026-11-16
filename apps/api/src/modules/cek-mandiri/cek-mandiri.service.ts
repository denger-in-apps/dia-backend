import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { intEnv } from '../../common/domain/env';
import { KonfigurasiSosService } from '../eskalasi/konfigurasi-sos.service';
import { KirimCekMandiriDto } from './cek-mandiri.dto';
import {
  buatRekomendasi,
  DISCLAIMER,
  hitungSkor,
  JUMLAH_BUTIR,
  KodeKuesioner,
  Rekomendasi,
  tingkatRisiko,
  TingkatRisiko,
} from './skor';

export interface TemplateKuesioner {
  id_template: string;
  kode: KodeKuesioner;
  nama: string;
  versi: number;
  butir: { pertanyaan_pembuka: string; butir: { no: number; teks: string }[]; opsi: { nilai: number; label: string }[] };
}

export interface HasilKuesioner {
  skor: number;
  skor_maks: number;
  tingkat: TingkatRisiko;
}

export interface HasilCekMandiri {
  id_cek: string;
  waktu_tes: Date;
  phq9: HasilKuesioner | null;
  gad7: HasilKuesioner | null;
  butir9_positif: boolean;
  /** `true` → FE menampilkan Genta + hotline secara menonjol (02-backend.md §9.1). */
  jalur_bantuan_segera: boolean;
  rekomendasi: Rekomendasi;
  hotline: { label: string; aktif: boolean } | null;
  disclaimer: string;
}

interface HasilRow {
  id_cek: string;
  waktu_tes: Date;
  skor_phq9: number | null;
  skor_gad7: number | null;
  risiko_phq9: TingkatRisiko | null;
  risiko_gad7: TingkatRisiko | null;
  butir9_positif: boolean;
  jawaban_enc?: Buffer | null;
}

const KOLOM = `id_cek::text AS id_cek, waktu_tes, skor_phq9, skor_gad7, risiko_phq9, risiko_gad7, butir9_positif`;

/** Batas pengisian per akun per 24 jam (02-backend.md §12: 20/hari/akun). */
export const maksCekPerHari = () => intEnv('CEK_MANDIRI_MAKS_PER_HARI', 20, 1, 200);

/**
 * Cek mandiri PHQ-9 & GAD-7 (PBI-15, FR-MHS-08). Skor dan rekomendasi dihitung server;
 * jawaban rinci disimpan terenkripsi (AAD `hasil_cek_mandiri:jawaban_enc:<id>`), sedangkan
 * skor/tingkat disimpan polos untuk laporan agregat anonim (v_laporan_cek_mandiri_bulanan).
 */
@Injectable()
export class CekMandiriService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly konfigurasi: KonfigurasiSosService,
  ) {}

  /** Template aktif versi terbaru untuk tiap kuesioner. */
  async template(): Promise<TemplateKuesioner[]> {
    const result = await this.pool.query<TemplateKuesioner>(
      `SELECT DISTINCT ON (kode) id_template::text AS id_template, kode, nama, versi, butir
       FROM template_kuesioner WHERE aktif ORDER BY kode, versi DESC`,
    );
    return result.rows;
  }

  async kirim(idMahasiswa: string, dto: KirimCekMandiriDto): Promise<HasilCekMandiri> {
    const isian: Partial<Record<KodeKuesioner, { idTemplate: string; jawaban: number[] }>> = {};
    const pasangan: [KodeKuesioner, string | undefined, number[] | undefined][] = [
      ['PHQ9', dto.id_template_phq9, dto.jawaban_phq9],
      ['GAD7', dto.id_template_gad7, dto.jawaban_gad7],
    ];
    for (const [kode, idTemplate, jawaban] of pasangan) {
      if ((idTemplate === undefined) !== (jawaban === undefined)) {
        throw new UnprocessableEntityException({
          kode: 'PASANGAN_TIDAK_LENGKAP',
          pesan: `${kode} membutuhkan id_template dan jawaban sekaligus`,
        });
      }
      if (idTemplate && jawaban) isian[kode] = { idTemplate, jawaban };
    }
    if (!isian.PHQ9 && !isian.GAD7) {
      throw new UnprocessableEntityException({ kode: 'JAWABAN_KOSONG', pesan: 'Isi minimal satu kuesioner' });
    }
    await this.validasiTemplate(isian);

    const hasil: Partial<Record<KodeKuesioner, HasilKuesioner>> = {};
    for (const kode of Object.keys(isian) as KodeKuesioner[]) {
      const skor = hitungSkor(isian[kode]!.jawaban);
      hasil[kode] = { skor, skor_maks: JUMLAH_BUTIR[kode] * 3, tingkat: tingkatRisiko(kode, skor) };
    }
    const butir9Positif = (isian.PHQ9?.jawaban[8] ?? 0) > 0;
    const rekomendasi = buatRekomendasi(Object.values(hasil).map((h) => h!.tingkat), butir9Positif);

    const idCek = randomUUID();
    const jawabanEnc = this.encryption.encrypt(
      JSON.stringify({ phq9: isian.PHQ9?.jawaban ?? null, gad7: isian.GAD7?.jawaban ?? null }),
      this.aad(idCek),
    );
    const row = await denganTransaksi(this.pool, async (client) => {
      await this.cekBatasHarian(client, idMahasiswa);
      const inserted = await client.query<HasilRow>(
        `INSERT INTO hasil_cek_mandiri
           (id_cek, skor_phq9, skor_gad7, risiko_phq9, risiko_gad7, butir9_positif, jawaban_enc, rekomendasi,
            id_template_phq9, id_template_gad7, id_mahasiswa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${KOLOM}`,
        [
          idCek, hasil.PHQ9?.skor ?? null, hasil.GAD7?.skor ?? null, hasil.PHQ9?.tingkat ?? null,
          hasil.GAD7?.tingkat ?? null, butir9Positif, jawabanEnc, rekomendasi.kode,
          isian.PHQ9?.idTemplate ?? null, isian.GAD7?.idTemplate ?? null, idMahasiswa,
        ],
      );
      return inserted.rows[0];
    });
    return this.toDto(row, rekomendasi, await this.hotlineBila(rekomendasi));
  }

  async riwayat(idMahasiswa: string, limit = 50) {
    const result = await this.pool.query<HasilRow & { rekomendasi: string | null }>(
      `SELECT ${KOLOM}, rekomendasi FROM hasil_cek_mandiri
       WHERE id_mahasiswa = $1 ORDER BY waktu_tes DESC LIMIT $2`,
      [idMahasiswa, limit],
    );
    return result.rows.map(({ rekomendasi, ...row }) => ({
      id_cek: row.id_cek,
      waktu_tes: row.waktu_tes,
      phq9: this.hasilKuesioner('PHQ9', row.skor_phq9, row.risiko_phq9),
      gad7: this.hasilKuesioner('GAD7', row.skor_gad7, row.risiko_gad7),
      butir9_positif: row.butir9_positif,
      rekomendasi_kode: rekomendasi,
    }));
  }

  /** Detail milik sendiri, termasuk jawaban rinci (terdekripsi). */
  async detail(idMahasiswa: string, idCek: string) {
    const result = await this.pool.query<HasilRow>(
      `SELECT ${KOLOM}, jawaban_enc FROM hasil_cek_mandiri WHERE id_cek = $1 AND id_mahasiswa = $2`,
      [idCek, idMahasiswa],
    );
    const row = result.rows[0];
    if (!row) throw this.tidakDitemukan();
    const tingkat = [row.risiko_phq9, row.risiko_gad7].filter((t): t is TingkatRisiko => t !== null);
    const rekomendasi = buatRekomendasi(tingkat, row.butir9_positif);
    const jawaban = row.jawaban_enc
      ? JSON.parse(this.encryption.decrypt(row.jawaban_enc, this.aad(idCek)).toString('utf8')) as { phq9: number[] | null; gad7: number[] | null }
      : null; // jawaban dihapus (mis. akun dihapus) — skor tetap untuk statistik
    return { ...this.toDto(row, rekomendasi, await this.hotlineBila(rekomendasi)), jawaban };
  }

  /** Mahasiswa menghapus hasil miliknya (RBAC 02-backend.md §7: C/R/D milik sendiri). */
  async hapus(idMahasiswa: string, idCek: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM hasil_cek_mandiri WHERE id_cek = $1 AND id_mahasiswa = $2`,
      [idCek, idMahasiswa],
    );
    if (result.rowCount !== 1) throw this.tidakDitemukan();
  }

  // ---------------------------------------------------------------------------

  private async validasiTemplate(isian: Partial<Record<KodeKuesioner, { idTemplate: string; jawaban: number[] }>>) {
    const ids = Object.values(isian).map((i) => i!.idTemplate);
    const result = await this.pool.query<{ id_template: string; kode: KodeKuesioner; jumlah_butir: number }>(
      `SELECT id_template::text AS id_template, kode, jsonb_array_length(butir->'butir') AS jumlah_butir
       FROM template_kuesioner WHERE id_template = ANY($1::uuid[]) AND aktif`,
      [ids],
    );
    for (const kode of Object.keys(isian) as KodeKuesioner[]) {
      const { idTemplate, jawaban } = isian[kode]!;
      const template = result.rows.find((row) => row.id_template === idTemplate);
      if (!template || template.kode !== kode) {
        throw new UnprocessableEntityException({
          kode: 'TEMPLATE_TIDAK_VALID',
          pesan: `Template ${kode} tidak ditemukan atau tidak aktif; muat ulang kuesioner`,
        });
      }
      if (template.jumlah_butir !== JUMLAH_BUTIR[kode] || jawaban.length !== JUMLAH_BUTIR[kode]) {
        throw new UnprocessableEntityException({
          kode: 'JUMLAH_JAWABAN_TIDAK_SESUAI',
          pesan: `${kode} membutuhkan tepat ${JUMLAH_BUTIR[kode]} jawaban`,
        });
      }
    }
  }

  private async cekBatasHarian(client: PoolClient, idMahasiswa: string): Promise<void> {
    // Serialisasi per mahasiswa agar batas tidak terlewati oleh kiriman paralel.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`cek-mandiri:${idMahasiswa}`]);
    const count = await client.query<{ jumlah: number }>(
      `SELECT count(*)::int AS jumlah FROM hasil_cek_mandiri
       WHERE id_mahasiswa = $1 AND waktu_tes > now() - interval '24 hours'`,
      [idMahasiswa],
    );
    if (count.rows[0].jumlah >= maksCekPerHari()) {
      throw new HttpException({
        kode: 'CEK_MANDIRI_TERLALU_SERING',
        pesan: 'Batas cek mandiri hari ini tercapai. Jika Anda butuh bantuan sekarang, gunakan tombol Genta.',
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Info hotline disertakan untuk rekomendasi bantuan segera (dari konfigurasi admin). */
  private async hotlineBila(rekomendasi: Rekomendasi) {
    if (rekomendasi.kode !== 'BANTUAN_SEGERA') return null;
    const config = await this.konfigurasi.ambil();
    return { label: config.hotline_label, aktif: config.hotline_aktif };
  }

  private toDto(row: HasilRow, rekomendasi: Rekomendasi, hotline: HasilCekMandiri['hotline']): HasilCekMandiri {
    return {
      id_cek: row.id_cek,
      waktu_tes: row.waktu_tes,
      phq9: this.hasilKuesioner('PHQ9', row.skor_phq9, row.risiko_phq9),
      gad7: this.hasilKuesioner('GAD7', row.skor_gad7, row.risiko_gad7),
      butir9_positif: row.butir9_positif,
      jalur_bantuan_segera: rekomendasi.kode === 'BANTUAN_SEGERA',
      rekomendasi,
      hotline,
      disclaimer: DISCLAIMER,
    };
  }

  private hasilKuesioner(kode: KodeKuesioner, skor: number | null, tingkat: TingkatRisiko | null): HasilKuesioner | null {
    return skor === null || tingkat === null ? null : { skor, skor_maks: JUMLAH_BUTIR[kode] * 3, tingkat };
  }

  private aad(idCek: string): string {
    return `hasil_cek_mandiri:jawaban_enc:${idCek}`;
  }

  private tidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'CEK_MANDIRI_TIDAK_DITEMUKAN', pesan: 'Hasil cek mandiri tidak ditemukan' });
  }
}
