import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { BuatPenerimaEskalasiDto, UbahPenerimaEskalasiDto } from './admin-eskalasi.dto';
import { maskNomor } from './sms/sms.provider';

export const MAKS_PENERIMA_ESKALASI = 20;

export interface PenerimaEskalasi {
  id: string;
  nama: string;
  /** Hanya bentuk tersamar yang dikembalikan API; nomor utuh tetap terenkripsi di DB. */
  no_telepon_masked: string;
  aktif: boolean;
  created_at: Date;
}

interface Row {
  id: string;
  nama: string;
  no_telepon_enc: Buffer;
  aktif: boolean;
  created_at: Date;
}

type Ctx = { ip?: string; userAgent?: string };

/** Daftar penerima SMS eskalasi kampus (FR-ADM-05), dikelola Dosen Admin. */
@Injectable()
export class PenerimaEskalasiService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async daftar(): Promise<PenerimaEskalasi[]> {
    const result = await this.pool.query<Row>(
      `SELECT id::text AS id, nama, no_telepon_enc, aktif, created_at
       FROM penerima_eskalasi ORDER BY aktif DESC, nama`,
    );
    return result.rows.map((row) => this.toDto(row));
  }

  async buat(admin: AuthenticatedUser, dto: BuatPenerimaEskalasiDto, ctx: Ctx): Promise<PenerimaEskalasi> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('penerima_eskalasi', 0))`);
      const count = await client.query<{ jumlah: number }>(`SELECT count(*)::int AS jumlah FROM penerima_eskalasi`);
      if (count.rows[0].jumlah >= MAKS_PENERIMA_ESKALASI) {
        throw new UnprocessableEntityException({
          kode: 'PENERIMA_ESKALASI_PENUH',
          pesan: `Maksimal ${MAKS_PENERIMA_ESKALASI} penerima eskalasi`,
        });
      }
      const id = randomUUID();
      const result = await client.query<Row>(
        `INSERT INTO penerima_eskalasi (id, nama, no_telepon_enc, aktif)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text AS id, nama, no_telepon_enc, aktif, created_at`,
        [id, dto.nama, this.encrypt(id, dto.no_telepon), dto.aktif ?? true],
      );
      await this.audit.catat({
        aktor: admin, aksi: 'PENERIMA_ESKALASI_BUAT', resourceType: 'penerima_eskalasi', resourceId: id,
        ip: ctx.ip, userAgent: ctx.userAgent,
      }, client);
      return this.toDto(result.rows[0]);
    });
  }

  async ubah(admin: AuthenticatedUser, id: string, dto: UbahPenerimaEskalasiDto, ctx: Ctx): Promise<PenerimaEskalasi> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (dto.nama !== undefined) { values.push(dto.nama); sets.push(`nama = $${values.length}`); }
    if (dto.no_telepon !== undefined) { values.push(this.encrypt(id, dto.no_telepon)); sets.push(`no_telepon_enc = $${values.length}`); }
    if (dto.aktif !== undefined) { values.push(dto.aktif); sets.push(`aktif = $${values.length}`); }

    return this.inTransaction(async (client) => {
      const result = sets.length
        ? await client.query<Row>(
          `UPDATE penerima_eskalasi SET ${sets.join(', ')} WHERE id = $1
           RETURNING id::text AS id, nama, no_telepon_enc, aktif, created_at`,
          values,
        )
        : await client.query<Row>(
          `SELECT id::text AS id, nama, no_telepon_enc, aktif, created_at FROM penerima_eskalasi WHERE id = $1`,
          values,
        );
      if (!result.rows[0]) throw this.notFound();
      if (sets.length) {
        await this.audit.catat({
          aktor: admin, aksi: 'PENERIMA_ESKALASI_UBAH', resourceType: 'penerima_eskalasi', resourceId: id,
          ip: ctx.ip, userAgent: ctx.userAgent,
          metadata: { field: Object.keys(dto).filter((key) => dto[key as keyof UbahPenerimaEskalasiDto] !== undefined) },
        }, client);
      }
      return this.toDto(result.rows[0]);
    });
  }

  async hapus(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<void> {
    await this.inTransaction(async (client) => {
      const result = await client.query(`DELETE FROM penerima_eskalasi WHERE id = $1`, [id]);
      if (result.rowCount !== 1) throw this.notFound();
      await this.audit.catat({
        aktor: admin, aksi: 'PENERIMA_ESKALASI_HAPUS', resourceType: 'penerima_eskalasi', resourceId: id,
        ip: ctx.ip, userAgent: ctx.userAgent,
      }, client);
    });
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private encrypt(id: string, nomor: string): Buffer {
    return this.encryption.encrypt(nomor, `penerima_eskalasi:no_telepon_enc:${id}`);
  }

  private toDto(row: Row): PenerimaEskalasi {
    let masked = '********';
    try {
      masked = maskNomor(this.encryption.decrypt(row.no_telepon_enc, `penerima_eskalasi:no_telepon_enc:${row.id}`).toString('utf8'));
    } catch {
      // Nomor rusak/kunci hilang: tampilkan placeholder agar admin dapat menggantinya.
    }
    return { id: row.id, nama: row.nama, no_telepon_masked: masked, aktif: row.aktif, created_at: row.created_at };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ kode: 'PENERIMA_ESKALASI_TIDAK_DITEMUKAN', pesan: 'Penerima eskalasi tidak ditemukan' });
  }
}
