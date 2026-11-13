import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { zonaWaktuJadwal } from '../../common/domain/zona-waktu';
import { BuatJadwalDto, DaftarJadwalQuery, UbahJadwalDto } from './admin-staf.dto';

export interface JadwalJaga {
  id: string;
  id_psikolog: string;
  nama_psikolog: string;
  tanggal: string;
  jam_mulai: string;
  jam_selesai: string;
  ditetapkan_oleh: string;
  created_at: Date;
}

type Ctx = { ip?: string; userAgent?: string };

/** Rentang maksimal satu kali tampil agar query tetap ringan. */
export const MAKS_RENTANG_HARI = 62;
const DEFAULT_RENTANG_HARI = 14;
const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';

const KOLOM = `j.id_jadwal::text AS id, j.id_psikolog::text AS id_psikolog, p.nama AS nama_psikolog,
  to_char(j.tanggal, 'YYYY-MM-DD') AS tanggal, to_char(j.jam_mulai, 'HH24:MI') AS jam_mulai,
  CASE WHEN j.jam_selesai = '24:00'::time THEN '24:00' ELSE to_char(j.jam_selesai, 'HH24:MI') END AS jam_selesai,
  j.id_dosen::text AS ditetapkan_oleh, j.created_at`;

function menit(jam: string): number {
  const [h, m] = jam.split(':').map(Number);
  return h * 60 + m;
}

function validTanggal(tanggal: string): boolean {
  const date = new Date(`${tanggal}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === tanggal;
}

/**
 * Jadwal jaga psikolog (FR-ADM-02). Jadwal menentukan siapa yang menerima notifikasi SOS
 * (PBI-07) dan disinkronkan ke `psikolog.status_jaga` setiap menit.
 * Shift melewati tengah malam dibuat sebagai dua entri (mis. 22:00–24:00 dan 00:00–06:00).
 */
@Injectable()
export class JadwalJagaService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async daftar(query: DaftarJadwalQuery): Promise<JadwalJaga[]> {
    const { dari, sampai } = this.rentang(query.dari, query.sampai);
    const result = await this.pool.query<JadwalJaga>(
      `SELECT ${KOLOM} FROM jadwal_jaga j JOIN psikolog p ON p.id_psikolog = j.id_psikolog
       WHERE j.tanggal BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR j.id_psikolog = $3::uuid)
       ORDER BY j.tanggal, j.jam_mulai, p.nama`,
      [dari, sampai, query.id_psikolog ?? null],
    );
    return result.rows;
  }

  /** Jadwal milik psikolog yang login (`GET /psikolog/jadwal-jaga`). */
  milikSaya(psikolog: AuthenticatedUser, query: Pick<DaftarJadwalQuery, 'dari' | 'sampai'>) {
    return this.daftar({ ...query, id_psikolog: psikolog.id });
  }

  async buat(admin: AuthenticatedUser, dto: BuatJadwalDto, ctx: Ctx): Promise<JadwalJaga> {
    this.validasiJam(dto.tanggal, dto.jam_mulai, dto.jam_selesai);
    return denganTransaksi(this.pool, async (client) => {
      await this.validasiPsikologDanWaktu(client, dto.id_psikolog, dto.tanggal, dto.jam_selesai);
      const id = await this.tulis(client, () => client.query<{ id: string }>(
        `INSERT INTO jadwal_jaga (tanggal, jam_mulai, jam_selesai, id_psikolog, id_dosen)
         VALUES ($1, $2, $3, $4, $5) RETURNING id_jadwal::text AS id`,
        [dto.tanggal, dto.jam_mulai, dto.jam_selesai, dto.id_psikolog, admin.id],
      ));
      await this.catat(client, admin, 'JADWAL_JAGA_BUAT', id, ctx, { id_psikolog: dto.id_psikolog, tanggal: dto.tanggal });
      return this.detailDengan(client, id);
    });
  }

  async ubah(admin: AuthenticatedUser, id: string, dto: UbahJadwalDto, ctx: Ctx): Promise<JadwalJaga> {
    return denganTransaksi(this.pool, async (client) => {
      const current = await this.detailDengan(client, id, true);
      const next = {
        id_psikolog: dto.id_psikolog ?? current.id_psikolog,
        tanggal: dto.tanggal ?? current.tanggal,
        jam_mulai: dto.jam_mulai ?? current.jam_mulai,
        jam_selesai: dto.jam_selesai ?? current.jam_selesai,
      };
      this.validasiJam(next.tanggal, next.jam_mulai, next.jam_selesai);
      await this.validasiPsikologDanWaktu(client, next.id_psikolog, next.tanggal, next.jam_selesai);
      await this.tulis(client, () => client.query<{ id: string }>(
        `UPDATE jadwal_jaga SET id_psikolog = $2, tanggal = $3, jam_mulai = $4, jam_selesai = $5, id_dosen = $6
         WHERE id_jadwal = $1 RETURNING id_jadwal::text AS id`,
        [id, next.id_psikolog, next.tanggal, next.jam_mulai, next.jam_selesai, admin.id],
      ));
      await this.catat(client, admin, 'JADWAL_JAGA_UBAH', id, ctx, { sebelum: current, sesudah: next });
      return this.detailDengan(client, id);
    });
  }

  async hapus(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<void> {
    await denganTransaksi(this.pool, async (client) => {
      const result = await client.query(`DELETE FROM jadwal_jaga WHERE id_jadwal = $1`, [id]);
      if (result.rowCount !== 1) throw this.notFound();
      await this.catat(client, admin, 'JADWAL_JAGA_HAPUS', id, ctx);
    });
  }

  private validasiJam(tanggal: string, jamMulai: string, jamSelesai: string): void {
    if (!validTanggal(tanggal)) {
      throw new BadRequestException({ kode: 'TANGGAL_TIDAK_VALID', pesan: 'Tanggal tidak valid' });
    }
    if (menit(jamSelesai) <= menit(jamMulai)) {
      throw new BadRequestException({
        kode: 'JAM_TIDAK_VALID',
        pesan: 'jam_selesai harus setelah jam_mulai; shift lewat tengah malam dibuat dua entri',
      });
    }
  }

  private async validasiPsikologDanWaktu(client: PoolClient, idPsikolog: string, tanggal: string, jamSelesai: string) {
    const result = await client.query<{ status_akun: string; sudah_lewat: boolean }>(
      `SELECT status_akun,
              ($2::date + $3::time) <= (now() AT TIME ZONE $4) AS sudah_lewat
       FROM psikolog WHERE id_psikolog = $1`,
      [idPsikolog, tanggal, jamSelesai, zonaWaktuJadwal()],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ kode: 'PSIKOLOG_TIDAK_DITEMUKAN', pesan: 'Psikolog tidak ditemukan' });
    if (row.status_akun !== 'AKTIF') {
      throw new UnprocessableEntityException({ kode: 'PSIKOLOG_TIDAK_AKTIF', pesan: 'Hanya psikolog aktif yang dapat dijadwalkan' });
    }
    if (row.sudah_lewat) {
      throw new UnprocessableEntityException({ kode: 'JADWAL_SUDAH_LEWAT', pesan: 'Jadwal yang sudah lewat tidak dapat dibuat/diubah' });
    }
  }

  private async tulis(client: PoolClient, query: () => Promise<{ rows: { id: string }[] }>): Promise<string> {
    try {
      const result = await query();
      if (!result.rows[0]) throw this.notFound();
      return result.rows[0].id;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === EXCLUSION_VIOLATION || code === UNIQUE_VIOLATION) {
        throw new ConflictException({ kode: 'JADWAL_BENTROK', pesan: 'Jadwal bertumpuk dengan jadwal jaga lain psikolog ini' });
      }
      throw error;
    }
  }

  private rentang(dari?: string, sampai?: string): { dari: string; sampai: string } {
    const today = new Date().toISOString().slice(0, 10);
    const start = dari ?? today;
    const end = sampai ?? new Date(Date.parse(`${start}T00:00:00Z`) + DEFAULT_RENTANG_HARI * 86_400_000).toISOString().slice(0, 10);
    if (!validTanggal(start) || !validTanggal(end)) {
      throw new BadRequestException({ kode: 'TANGGAL_TIDAK_VALID', pesan: 'Tanggal tidak valid' });
    }
    const hari = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (hari < 0 || hari > MAKS_RENTANG_HARI) {
      throw new BadRequestException({
        kode: 'RENTANG_TIDAK_VALID',
        pesan: `Rentang tanggal harus 0–${MAKS_RENTANG_HARI} hari dan 'sampai' tidak sebelum 'dari'`,
      });
    }
    return { dari: start, sampai: end };
  }

  private async detailDengan(client: PoolClient, id: string, lock = false): Promise<JadwalJaga> {
    const result = await client.query<JadwalJaga>(
      `SELECT ${KOLOM} FROM jadwal_jaga j JOIN psikolog p ON p.id_psikolog = j.id_psikolog
       WHERE j.id_jadwal = $1 ${lock ? 'FOR UPDATE OF j' : ''}`,
      [id],
    );
    if (!result.rows[0]) throw this.notFound();
    return result.rows[0];
  }

  private catat(client: PoolClient, admin: AuthenticatedUser, aksi: string, id: string, ctx: Ctx, metadata?: Record<string, unknown>) {
    return this.audit.catat({
      aktor: admin, aksi, resourceType: 'jadwal_jaga', resourceId: id, ip: ctx.ip, userAgent: ctx.userAgent, metadata,
    }, client);
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ kode: 'JADWAL_TIDAK_DITEMUKAN', pesan: 'Jadwal jaga tidak ditemukan' });
  }
}
