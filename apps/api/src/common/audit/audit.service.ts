import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuthenticatedUser } from '../auth/auth.types';

export interface AuditEntry {
  aktor?: AuthenticatedUser;
  /** Kode aksi, mis. DATA_EKSPOR, DATA_HAPUS, SOS_AMBIL, SOS_LOKASI_READ. */
  aksi: string;
  resourceType: string;
  resourceId?: string;
  hasil?: 'SUKSES' | 'DITOLAK';
  ip?: string;
  userAgent?: string;
  /** Hanya metadata non-sensitif; jangan pernah isi data pribadi atau isi pesan. */
  metadata?: Record<string, unknown>;
}

/**
 * Pencatat audit_log (append-only, FR-ADM-06 / NFR-08). Bila diberi `client`
 * transaksi, catatan audit ikut commit/rollback bersama aksi yang diaudit.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async catat(entry: AuditEntry, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO audit_log
         (aktor_id, aktor_role, aksi, resource_type, resource_id, hasil, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.aktor?.id ?? null,
        entry.aktor?.role ?? null,
        entry.aksi,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.hasil ?? 'SUKSES',
        entry.ip ?? null,
        entry.userAgent?.slice(0, 512) ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }
}
