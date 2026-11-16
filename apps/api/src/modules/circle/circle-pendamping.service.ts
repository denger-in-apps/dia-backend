import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { CirclePesanService, PesanCircle } from './circle-pesan.service';
import { CircleRow, circleTidakDitemukan, FROM_CIRCLE, KOLOM_CIRCLE, toCircleRingkas } from './circle.service';

type Ctx = { ip?: string; userAgent?: string };

/**
 * Dashboard pendampingan & moderasi Circle oleh psikolog pendamping (PBI-18 / SCRUM-267,
 * FR-PSI-06). Hanya Circle yang ditetapkan untuk psikolog ini (`circle.id_psikolog`).
 * Pendamping melihat anggota seperti sesama anggota (alias bila anonim) — anonimitas
 * terhadap pendamping tetap terjaga (NFR-04).
 */
@Injectable()
export class CirclePendampingService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly pesan: CirclePesanService,
    private readonly audit: AuditService,
  ) {}

  /** Circle dampingan + indikator aktivitas untuk memprioritaskan perhatian. */
  async daftar(psikolog: AuthenticatedUser) {
    const result = await this.pool.query(
      `SELECT ${KOLOM_CIRCLE},
              (SELECT count(*)::int FROM circle_pesan cp WHERE cp.id_circle = c.id_circle
                AND cp.created_at > now() - interval '7 days') AS pesan_7_hari,
              (SELECT count(*)::int FROM circle_pesan cp WHERE cp.id_circle = c.id_circle AND cp.disembunyikan) AS pesan_disembunyikan,
              (SELECT max(cp.created_at) FROM circle_pesan cp WHERE cp.id_circle = c.id_circle) AS aktivitas_terakhir
       ${FROM_CIRCLE}
       WHERE c.id_psikolog = $1 AND c.status IN ('AKTIF', 'DITUTUP')
       ORDER BY c.status, aktivitas_terakhir DESC NULLS LAST, c.nama_circle`,
      [psikolog.id],
    );
    return result.rows.map((row) => ({
      ...toCircleRingkas(row),
      pesan_7_hari: row.pesan_7_hari,
      pesan_disembunyikan: row.pesan_disembunyikan,
      aktivitas_terakhir: row.aktivitas_terakhir,
    }));
  }

  async detail(psikolog: AuthenticatedUser, idCircle: string) {
    const circle = await this.circleDampingan(this.pool, psikolog, idCircle);
    const anggota = await this.pool.query<{ nama: string; anonim: boolean; joined_at: Date }>(
      `SELECT CASE WHEN k.status_anonim THEN k.alias_anonim ELSE COALESCE(m.nama_tampilan, m.nama) END AS nama,
              k.status_anonim AS anonim, k.joined_at
       FROM keanggotaan_circle k JOIN mahasiswa m ON m.id_mahasiswa = k.id_mahasiswa
       WHERE k.id_circle = $1 ORDER BY k.joined_at`,
      [idCircle],
    );
    return { ...toCircleRingkas(circle), anggota: anggota.rows };
  }

  /** Pendamping melihat isi pesan yang disembunyikan (untuk peninjauan) beserta alasannya. */
  async daftarPesan(psikolog: AuthenticatedUser, idCircle: string, sebelum?: string, limit?: number): Promise<PesanCircle[]> {
    await this.circleDampingan(this.pool, psikolog, idCircle);
    return this.pesan.daftar(idCircle, { tipe: 'PSIKOLOG', id: psikolog.id }, sebelum, limit);
  }

  async kirimPesan(psikolog: AuthenticatedUser, idCircle: string, isi: string): Promise<{ id_pesan: string }> {
    const id = await denganTransaksi(this.pool, async (client) => {
      const circle = await this.circleDampingan(client, psikolog, idCircle);
      if (circle.status !== 'AKTIF') throw new ConflictException({ kode: 'CIRCLE_TIDAK_AKTIF', pesan: 'Circle sudah ditutup' });
      return this.pesan.kirim(client, idCircle, { tipe: 'PSIKOLOG', id: psikolog.id }, isi);
    });
    return { id_pesan: id };
  }

  /** Sembunyikan pesan dengan alasan (terlihat anggota); diaudit `CIRCLE_MODERASI`. */
  async sembunyikan(psikolog: AuthenticatedUser, idCircle: string, idPesan: string, alasan: string, ctx: Ctx) {
    return this.moderasi(psikolog, idCircle, idPesan, true, alasan, ctx);
  }

  /** Batalkan moderasi (salah sembunyikan); diaudit `CIRCLE_MODERASI`. */
  async pulihkan(psikolog: AuthenticatedUser, idCircle: string, idPesan: string, ctx: Ctx) {
    return this.moderasi(psikolog, idCircle, idPesan, false, null, ctx);
  }

  private async moderasi(
    psikolog: AuthenticatedUser,
    idCircle: string,
    idPesan: string,
    sembunyikan: boolean,
    alasan: string | null,
    ctx: Ctx,
  ) {
    return denganTransaksi(this.pool, async (client) => {
      await this.circleDampingan(client, psikolog, idCircle);
      const result = await client.query<{ id_pesan: string; disembunyikan: boolean; alasan_moderasi: string | null }>(
        `UPDATE circle_pesan SET disembunyikan = $3, alasan_moderasi = $4
         WHERE id_pesan = $1 AND id_circle = $2
         RETURNING id_pesan::text AS id_pesan, disembunyikan, alasan_moderasi`,
        [idPesan, idCircle, sembunyikan, alasan],
      );
      if (!result.rows[0]) throw new NotFoundException({ kode: 'PESAN_TIDAK_DITEMUKAN', pesan: 'Pesan tidak ditemukan' });
      await this.audit.catat({
        aktor: psikolog, aksi: 'CIRCLE_MODERASI', resourceType: 'circle_pesan', resourceId: idPesan,
        ip: ctx.ip, userAgent: ctx.userAgent,
        metadata: { id_circle: idCircle, aksi: sembunyikan ? 'SEMBUNYIKAN' : 'PULIHKAN' },
      }, client);
      return result.rows[0];
    });
  }

  private async circleDampingan(executor: Pool | PoolClient, psikolog: AuthenticatedUser, idCircle: string) {
    const result = await executor.query<CircleRow>(
      `SELECT ${KOLOM_CIRCLE} ${FROM_CIRCLE}
       WHERE c.id_circle = $1 AND c.id_psikolog = $2 AND c.status IN ('AKTIF', 'DITUTUP')`,
      [idCircle, psikolog.id],
    );
    // Circle psikolog lain tidak dibedakan dari yang tidak ada (keberadaan tidak bocor).
    if (!result.rows[0]) throw circleTidakDitemukan();
    return result.rows[0];
  }
}
