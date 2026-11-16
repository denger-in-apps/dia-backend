import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DaftarCurhatPsikologQuery, StatusCurhat } from './curhat.dto';
import { aadBalasan, aadCurhat, BalasanCurhat, curhatTidakDitemukan, CurhatService } from './curhat.service';

export interface KonteksPermintaan {
  ip?: string;
  userAgent?: string;
}

/** Curhat sebagaimana terlihat psikolog: TANPA identitas mahasiswa. */
export interface CurhatUntukPsikolog {
  id_curhat: string;
  waktu_curhat: Date;
  status: StatusCurhat;
  alias_anonim: string;
  isi: string;
  jumlah_balasan: number;
}

interface ViewRow extends Omit<CurhatUntukPsikolog, 'isi'> {
  isi_curhat_enc: Buffer;
}

const KOLOM = `v.id_curhat::text AS id_curhat, v.waktu_curhat, v.status, v.alias_anonim, v.isi_curhat_enc,
  (SELECT count(*)::int FROM curhat_balasan b WHERE b.id_curhat = v.id_curhat) AS jumlah_balasan`;

/**
 * Ruang curhat — sisi psikolog (PBI-16 / SCRUM-261, FR-PSI-05).
 *
 * Pembacaan HANYA lewat `v_curhat_untuk_psikolog` (tanpa `id_mahasiswa`, 04-database.md §4.d).
 * Tabel dasar disentuh hanya untuk memperbarui status dan membuat notifikasi ke mahasiswa —
 * identitasnya tidak pernah dikembalikan ke psikolog. Akses dicatat `CURHAT_READ`/`CURHAT_BALAS`.
 */
@Injectable()
export class CurhatPsikologService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly curhat: CurhatService,
  ) {}

  /** Antrean: belum dijawab dulu (BARU → DIBACA → DIJAWAB), lalu yang paling lama menunggu. */
  async daftar(psikolog: AuthenticatedUser, query: DaftarCurhatPsikologQuery, ctx: KonteksPermintaan): Promise<CurhatUntukPsikolog[]> {
    const result = await this.pool.query<ViewRow>(
      `SELECT ${KOLOM} FROM v_curhat_untuk_psikolog v
       WHERE ($1::status_curhat IS NULL OR v.status = $1::status_curhat)
       ORDER BY v.status, v.waktu_curhat ASC
       LIMIT $2`,
      [query.status ?? null, query.limit ?? 50],
    );
    await this.audit.catat({
      aktor: psikolog, aksi: 'CURHAT_READ', resourceType: 'curhat_anonim', ip: ctx.ip, userAgent: ctx.userAgent,
      metadata: { daftar: true, jumlah: result.rows.length, status: query.status ?? null },
    });
    return result.rows.map((row) => this.toDto(row));
  }

  /** Detail + balasan; curhat BARU ditandai DIBACA. */
  async detail(
    psikolog: AuthenticatedUser,
    idCurhat: string,
    ctx: KonteksPermintaan,
  ): Promise<CurhatUntukPsikolog & { balasan: BalasanCurhat[] }> {
    const result = await this.pool.query<ViewRow>(`SELECT ${KOLOM} FROM v_curhat_untuk_psikolog v WHERE v.id_curhat = $1`, [idCurhat]);
    const row = result.rows[0];
    if (!row) throw curhatTidakDitemukan();
    if (row.status === 'BARU') {
      await this.pool.query(`UPDATE curhat_anonim SET status = 'DIBACA' WHERE id_curhat = $1 AND status = 'BARU'`, [idCurhat]);
      row.status = 'DIBACA';
    }
    await this.audit.catat({
      aktor: psikolog, aksi: 'CURHAT_READ', resourceType: 'curhat_anonim', resourceId: idCurhat,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { ...this.toDto(row), balasan: await this.curhat.balasan(idCurhat) };
  }

  /** Beri saran: balasan terenkripsi, status DIJAWAB, mahasiswa dikabari (`CURHAT_DIJAWAB`). */
  async balas(psikolog: AuthenticatedUser, idCurhat: string, isi: string, ctx: KonteksPermintaan): Promise<BalasanCurhat> {
    const idBalasan = randomUUID();
    const enc = this.encryption.encrypt(isi, aadBalasan(idBalasan));
    const waktu = await denganTransaksi(this.pool, async (client) => {
      const status = await client.query(
        `UPDATE curhat_anonim SET status = 'DIJAWAB' WHERE id_curhat = $1 RETURNING 1`,
        [idCurhat],
      );
      if (!status.rowCount) throw curhatTidakDitemukan();
      const inserted = await client.query<{ waktu: Date }>(
        `INSERT INTO curhat_balasan (id_balasan, id_curhat, id_psikolog, isi_enc) VALUES ($1, $2, $3, $4) RETURNING waktu`,
        [idBalasan, idCurhat, psikolog.id, enc],
      );
      // Penerima diambil di dalam SQL; id_mahasiswa tidak pernah keluar ke psikolog. Isi tidak disertakan.
      await client.query(
        `INSERT INTO notifikasi (id_penerima, role, jenis, payload)
         SELECT id_mahasiswa, 'MAHASISWA', 'CURHAT_DIJAWAB', jsonb_build_object('id_curhat', id_curhat::text)
         FROM curhat_anonim WHERE id_curhat = $1`,
        [idCurhat],
      );
      await this.audit.catat({
        aktor: psikolog, aksi: 'CURHAT_BALAS', resourceType: 'curhat_anonim', resourceId: idCurhat,
        ip: ctx.ip, userAgent: ctx.userAgent,
      }, client);
      return inserted.rows[0].waktu;
    });
    const nama = await this.pool.query<{ nama: string }>(`SELECT nama FROM psikolog WHERE id_psikolog = $1`, [psikolog.id]);
    return { id_balasan: idBalasan, isi, waktu, nama_psikolog: nama.rows[0]?.nama ?? '' };
  }

  private toDto(row: ViewRow): CurhatUntukPsikolog {
    const { isi_curhat_enc, ...rest } = row;
    return { ...rest, isi: this.encryption.decrypt(isi_curhat_enc, aadCurhat(row.id_curhat)).toString('utf8') };
  }
}
