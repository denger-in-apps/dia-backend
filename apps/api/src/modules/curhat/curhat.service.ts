import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { intEnv } from '../../common/domain/env';
import { KonfigurasiSosService } from '../eskalasi/konfigurasi-sos.service';
import { StatusCurhat } from './curhat.dto';

export const maksCurhatPerJam = () => intEnv('CURHAT_MAKS_PER_JAM', 10, 1, 100);

export interface BalasanCurhat {
  id_balasan: string;
  isi: string;
  waktu: Date;
  /** Nama psikolog yang membalas (psikolog tidak anonim terhadap mahasiswa). */
  nama_psikolog: string;
}

export interface CurhatMahasiswa {
  id_curhat: string;
  waktu_curhat: Date;
  status: StatusCurhat;
  alias_anonim: string;
  isi: string;
  jumlah_balasan: number;
}

/** Info bantuan yang selalu disertakan: aturan curhat berisiko tinggi belum didefinisikan (PBI-16). */
export interface InfoBantuan {
  pesan: string;
  hotline: { label: string; aktif: boolean };
}

interface CurhatRow {
  id_curhat: string;
  waktu_curhat: Date;
  status: StatusCurhat;
  alias_anonim: string;
  isi_curhat_enc: Buffer;
  jumlah_balasan: number;
}

export const aadCurhat = (idCurhat: string) => `curhat_anonim:isi_curhat_enc:${idCurhat}`;
export const aadBalasan = (idBalasan: string) => `curhat_balasan:isi_enc:${idBalasan}`;

/**
 * Ruang curhat anonim — sisi mahasiswa (PBI-16 / SCRUM-260, FR-MHS-09).
 *
 * Isi terenkripsi (AAD per baris). `alias_anonim` = `Anonim-` + 6 hex HMAC(id_mahasiswa)
 * dengan kunci turunan dari kunci enkripsi, sehingga stabil antar curhat (psikolog dapat
 * mengikuti percakapan) tetapi tidak dapat dibalik tanpa kunci server. Anonimitas berlaku
 * terhadap psikolog/pengguna lain, bukan terhadap sistem (02-backend.md §9.2) — sampaikan jujur di UI.
 */
@Injectable()
export class CurhatService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly konfigurasi: KonfigurasiSosService,
  ) {}

  aliasAnonim(idMahasiswa: string): string {
    const hmac = createHmac('sha256', this.encryption.turunkanKunci('alias-curhat')).update(idMahasiswa).digest('hex');
    return `Anonim-${hmac.slice(0, 6).toUpperCase()}`;
  }

  async kirim(idMahasiswa: string, isi: string): Promise<CurhatMahasiswa & { bantuan: InfoBantuan }> {
    const idCurhat = randomUUID();
    const alias = this.aliasAnonim(idMahasiswa);
    const enc = this.encryption.encrypt(isi, aadCurhat(idCurhat));
    const row = await denganTransaksi(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`curhat:${idMahasiswa}`]);
      const count = await client.query<{ jumlah: number }>(
        `SELECT count(*)::int AS jumlah FROM curhat_anonim
         WHERE id_mahasiswa = $1 AND waktu_curhat > now() - interval '1 hour'`,
        [idMahasiswa],
      );
      if (count.rows[0].jumlah >= maksCurhatPerJam()) {
        throw new HttpException({
          kode: 'CURHAT_TERLALU_SERING',
          pesan: 'Batas curhat per jam tercapai. Jika Anda butuh bantuan sekarang, gunakan tombol Genta.',
          detail: { bantuan: await this.bantuan() },
        }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const inserted = await client.query<CurhatRow>(
        `INSERT INTO curhat_anonim (id_curhat, isi_curhat_enc, alias_anonim, id_mahasiswa)
         VALUES ($1, $2, $3, $4)
         RETURNING id_curhat::text AS id_curhat, waktu_curhat, status, alias_anonim, isi_curhat_enc, 0 AS jumlah_balasan`,
        [idCurhat, enc, alias, idMahasiswa],
      );
      return inserted.rows[0];
    });
    return { ...this.toDto(row, isi), bantuan: await this.bantuan() };
  }

  async daftar(idMahasiswa: string, limit = 50): Promise<CurhatMahasiswa[]> {
    const result = await this.pool.query<CurhatRow>(
      `SELECT c.id_curhat::text AS id_curhat, c.waktu_curhat, c.status, c.alias_anonim, c.isi_curhat_enc,
              (SELECT count(*)::int FROM curhat_balasan b WHERE b.id_curhat = c.id_curhat) AS jumlah_balasan
       FROM curhat_anonim c WHERE c.id_mahasiswa = $1
       ORDER BY c.waktu_curhat DESC LIMIT $2`,
      [idMahasiswa, limit],
    );
    return result.rows.map((row) => this.toDto(row, this.dekripsi(row)));
  }

  async detail(idMahasiswa: string, idCurhat: string): Promise<CurhatMahasiswa & { balasan: BalasanCurhat[] }> {
    const result = await this.pool.query<CurhatRow>(
      `SELECT c.id_curhat::text AS id_curhat, c.waktu_curhat, c.status, c.alias_anonim, c.isi_curhat_enc,
              (SELECT count(*)::int FROM curhat_balasan b WHERE b.id_curhat = c.id_curhat) AS jumlah_balasan
       FROM curhat_anonim c WHERE c.id_curhat = $1 AND c.id_mahasiswa = $2`,
      [idCurhat, idMahasiswa],
    );
    const row = result.rows[0];
    if (!row) throw curhatTidakDitemukan();
    return { ...this.toDto(row, this.dekripsi(row)), balasan: await this.balasan(idCurhat) };
  }

  /** Mahasiswa menghapus curhatnya (beserta balasan, ON DELETE CASCADE). */
  async hapus(idMahasiswa: string, idCurhat: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM curhat_anonim WHERE id_curhat = $1 AND id_mahasiswa = $2`,
      [idCurhat, idMahasiswa],
    );
    if (result.rowCount !== 1) throw curhatTidakDitemukan();
  }

  /** Balasan sebuah curhat (dipakai sisi mahasiswa & psikolog), terdekripsi, urut waktu. */
  async balasan(idCurhat: string): Promise<BalasanCurhat[]> {
    const result = await this.pool.query<{ id_balasan: string; isi_enc: Buffer; waktu: Date; nama_psikolog: string }>(
      `SELECT b.id_balasan::text AS id_balasan, b.isi_enc, b.waktu, p.nama AS nama_psikolog
       FROM curhat_balasan b JOIN psikolog p ON p.id_psikolog = b.id_psikolog
       WHERE b.id_curhat = $1 ORDER BY b.waktu`,
      [idCurhat],
    );
    return result.rows.map(({ isi_enc, ...row }) => ({
      ...row,
      isi: this.encryption.decrypt(isi_enc, aadBalasan(row.id_balasan)).toString('utf8'),
    }));
  }

  private async bantuan(): Promise<InfoBantuan> {
    const config = await this.konfigurasi.ambil();
    return {
      pesan: 'Curhat dibaca psikolog, tetapi tidak dipantau setiap saat. Jika Anda dalam bahaya atau '
        + 'ingin menyakiti diri, gunakan tombol Genta atau hubungi hotline sekarang.',
      hotline: { label: config.hotline_label, aktif: config.hotline_aktif },
    };
  }

  private dekripsi(row: CurhatRow): string {
    return this.encryption.decrypt(row.isi_curhat_enc, aadCurhat(row.id_curhat)).toString('utf8');
  }

  private toDto(row: CurhatRow, isi: string): CurhatMahasiswa {
    const { isi_curhat_enc: _enc, ...rest } = row;
    return { ...rest, isi };
  }
}

export function curhatTidakDitemukan(): NotFoundException {
  return new NotFoundException({ kode: 'CURHAT_TIDAK_DITEMUKAN', pesan: 'Curhat tidak ditemukan' });
}
