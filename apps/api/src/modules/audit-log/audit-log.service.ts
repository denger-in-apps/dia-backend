import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { DaftarAuditLogQuery, FilterAuditLogQuery } from './audit-log.dto';

type Ctx = { ip?: string; userAgent?: string };

export const MAKS_EKSPOR = 10_000;

export interface EntriAuditLog {
  id_log: number;
  waktu: Date;
  aktor: { id: string | null; role: string | null; nama: string | null };
  aksi: string;
  resource_type: string;
  resource_id: string | null;
  hasil: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

interface AuditRow {
  id_log: string;
  waktu: Date;
  aktor_id: string | null;
  aktor_role: string | null;
  aktor_nama: string | null;
  aksi: string;
  resource_type: string;
  resource_id: string | null;
  hasil: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

/** Nama hanya untuk aktor staf; aktor mahasiswa cukup id (minimisasi data). */
const SELECT_AUDIT = `SELECT a.id_log, a.waktu, a.aktor_id::text AS aktor_id, a.aktor_role, a.aksi, a.resource_type,
    a.resource_id, a.hasil, host(a.ip) AS ip, a.user_agent, a.metadata,
    CASE a.aktor_role WHEN 'PSIKOLOG' THEN p.nama WHEN 'DOSEN_ADMIN' THEN d.nama END AS aktor_nama
  FROM audit_log a
  LEFT JOIN psikolog p ON a.aktor_role = 'PSIKOLOG' AND p.id_psikolog = a.aktor_id
  LEFT JOIN dosen_admin d ON a.aktor_role = 'DOSEN_ADMIN' AND d.id_dosen = a.aktor_id
  WHERE ($1::uuid IS NULL OR a.aktor_id = $1::uuid)
    AND ($2::role_pengguna IS NULL OR a.aktor_role = $2::role_pengguna)
    AND ($3::text[] IS NULL OR a.aksi = ANY($3::text[]))
    AND ($4::text IS NULL OR a.resource_type = $4)
    AND ($5::text IS NULL OR a.resource_id = $5)
    AND ($6::text IS NULL OR a.hasil = $6)
    AND ($7::timestamptz IS NULL OR a.waktu >= $7::timestamptz)
    AND ($8::timestamptz IS NULL OR a.waktu < $8::timestamptz)
    AND ($9::bigint IS NULL OR a.id_log < $9::bigint)
  ORDER BY a.id_log DESC
  LIMIT $10`;

const KOLOM_CSV = ['id_log', 'waktu', 'aktor_id', 'aktor_role', 'aktor_nama', 'aksi', 'resource_type', 'resource_id', 'hasil', 'ip', 'user_agent', 'metadata'] as const;

/**
 * Peninjauan audit log keamanan oleh Dosen Admin (PBI-21 / SCRUM-277, FR-ADM-06, NFR-08).
 * `audit_log` bersifat append-only (trigger DB + REVOKE UPDATE/DELETE pada `denger_app`), dan
 * setiap pembacaan/ekspor oleh admin ikut dicatat (`AUDIT_LOG_READ` / `AUDIT_LOG_EKSPOR`)
 * sehingga penggunaan wewenang ini pun dapat ditelusuri.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async daftar(admin: AuthenticatedUser, query: DaftarAuditLogQuery, ctx: Ctx) {
    const limit = query.limit ?? 50;
    const rows = await this.cari(query, limit, query.sebelum);
    await this.audit.catat({
      aktor: admin, aksi: 'AUDIT_LOG_READ', resourceType: 'audit_log', ip: ctx.ip, userAgent: ctx.userAgent,
      metadata: { filter: this.ringkasFilter(query), jumlah: rows.length },
    });
    const data = rows.map((row) => this.toDto(row));
    return { data, berikutnya: data.length === limit ? data[data.length - 1].id_log : null };
  }

  /** Kode aksi yang muncul 90 hari terakhir beserta jumlahnya (untuk pilihan filter). */
  async daftarAksi() {
    const result = await this.pool.query<{ aksi: string; jumlah: number; ditolak: number }>(
      `SELECT aksi, count(*)::int AS jumlah, count(*) FILTER (WHERE hasil = 'DITOLAK')::int AS ditolak
       FROM audit_log WHERE waktu > now() - interval '90 days' GROUP BY aksi ORDER BY aksi`,
    );
    return result.rows;
  }

  /** CSV maks. 10 000 baris terbaru sesuai filter; nilai berisiko formula diberi prefiks `'`. */
  async ekspor(admin: AuthenticatedUser, query: FilterAuditLogQuery, ctx: Ctx): Promise<{ csv: string; jumlah: number }> {
    const rows = await this.cari(query, MAKS_EKSPOR);
    await this.audit.catat({
      aktor: admin, aksi: 'AUDIT_LOG_EKSPOR', resourceType: 'audit_log', ip: ctx.ip, userAgent: ctx.userAgent,
      metadata: { filter: this.ringkasFilter(query), jumlah: rows.length },
    });
    const baris = rows.map((row) => KOLOM_CSV.map((kolom) => {
      const nilai = row[kolom];
      if (nilai === null || nilai === undefined) return '';
      if (nilai instanceof Date) return nilai.toISOString();
      return csvSel(typeof nilai === 'object' ? JSON.stringify(nilai) : String(nilai));
    }).join(','));
    return { csv: [KOLOM_CSV.join(','), ...baris].join('\r\n') + '\r\n', jumlah: rows.length };
  }

  // ---------------------------------------------------------------------------

  private async cari(query: FilterAuditLogQuery, limit: number, sebelum?: number): Promise<AuditRow[]> {
    const { dari, sampai } = this.rentang(query.dari, query.sampai);
    const result = await this.pool.query<AuditRow>(SELECT_AUDIT, [
      query.aktor ?? null,
      query.aktor_role ?? null,
      query.aksi ? query.aksi.split(',') : null,
      query.resource_type ?? null,
      query.resource_id ?? null,
      query.hasil ?? null,
      dari,
      sampai,
      sebelum ?? null,
      limit,
    ]);
    return result.rows;
  }

  /** `sampai` berupa tanggal saja berarti sampai akhir hari itu (eksklusif hari berikutnya, UTC). */
  private rentang(dari?: string, sampai?: string): { dari: string | null; sampai: string | null } {
    const awal = dari ? new Date(dari.length === 10 ? `${dari}T00:00:00Z` : dari) : null;
    let akhir = sampai ? new Date(sampai.length === 10 ? `${sampai}T00:00:00Z` : sampai) : null;
    if (akhir && sampai!.length === 10) akhir = new Date(akhir.getTime() + 86_400_000);
    if ((awal && Number.isNaN(awal.getTime())) || (akhir && Number.isNaN(akhir.getTime()))) {
      throw new BadRequestException({ kode: 'WAKTU_TIDAK_VALID', pesan: 'Rentang waktu tidak valid' });
    }
    if (awal && akhir && awal >= akhir) {
      throw new BadRequestException({ kode: 'WAKTU_TIDAK_VALID', pesan: "'dari' harus sebelum 'sampai'" });
    }
    return { dari: awal?.toISOString() ?? null, sampai: akhir?.toISOString() ?? null };
  }

  private ringkasFilter(query: FilterAuditLogQuery) {
    return Object.fromEntries(
      (['aktor', 'aktor_role', 'aksi', 'resource_type', 'resource_id', 'hasil', 'dari', 'sampai'] as const)
        .filter((k) => query[k] !== undefined)
        .map((k) => [k, query[k]]),
    );
  }

  private toDto(row: AuditRow): EntriAuditLog {
    return {
      id_log: Number(row.id_log),
      waktu: row.waktu,
      aktor: { id: row.aktor_id, role: row.aktor_role, nama: row.aktor_nama },
      aksi: row.aksi,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      hasil: row.hasil,
      ip: row.ip,
      user_agent: row.user_agent,
      metadata: row.metadata,
    };
  }
}

/** Sel CSV aman: kutip ganda bila perlu, dan cegah formula injection di aplikasi spreadsheet. */
export function csvSel(nilai: string): string {
  const aman = /^[=+\-@\t\r]/.test(nilai) ? `'${nilai}` : nilai;
  return /[",\r\n]/.test(aman) ? `"${aman.replace(/"/g, '""')}"` : aman;
}
