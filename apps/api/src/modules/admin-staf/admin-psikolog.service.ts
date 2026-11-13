import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { zonaWaktuJadwal } from '../../common/domain/zona-waktu';
import { PsikologGateway } from '../realtime/psikolog.gateway';
import { SosNotifikasiService } from '../realtime/sos-notifikasi.service';
import { BuatPsikologDto, DaftarPsikologQuery, UbahPsikologDto } from './admin-staf.dto';

export interface PsikologAdmin {
  id: string;
  nama: string;
  email: string;
  status_akun: 'MENUNGGU_VERIFIKASI' | 'AKTIF' | 'NONAKTIF';
  status_jaga: boolean;
  mfa_aktif: boolean;
  wajib_ganti_password: boolean;
  diverifikasi_at: Date | null;
  kasus_aktif: number;
  created_at: Date;
}

type Ctx = { ip?: string; userAgent?: string };

const KOLOM = `p.id_psikolog::text AS id, p.nama, p.email::text AS email, p.status_akun, p.status_jaga,
  (p.mfa_secret_enc IS NOT NULL) AS mfa_aktif, p.wajib_ganti_password, p.diverifikasi_at, p.created_at,
  (SELECT count(*)::int FROM log_sos s
    WHERE s.id_psikolog = p.id_psikolog AND s.status_penanganan IN ('DIAMBIL', 'DITANGANI')) AS kasus_aktif`;

const UNIQUE_VIOLATION = '23505';

/** Password sementara acak (≥ 22 karakter base64url), ditampilkan sekali ke admin. */
function passwordSementara(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Kelola akun psikolog oleh Dosen Admin (FR-ADM-02; use case "Login Akun Staf" alt 4.a).
 * Akun baru berstatus MENUNGGU_VERIFIKASI dan baru dapat login setelah diaktifkan.
 */
@Injectable()
export class AdminPsikologService {
  private readonly logger = new Logger(AdminPsikologService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly notifikasi: SosNotifikasiService,
    private readonly gateway: PsikologGateway,
  ) {}

  async daftar(query: DaftarPsikologQuery): Promise<PsikologAdmin[]> {
    const result = await this.pool.query<PsikologAdmin>(
      `SELECT ${KOLOM} FROM psikolog p
       WHERE ($1::status_akun_staf IS NULL OR p.status_akun = $1::status_akun_staf)
         AND ($2::text IS NULL OR p.nama ILIKE '%' || $2 || '%' OR p.email::text ILIKE '%' || $2 || '%')
       ORDER BY p.status_akun, p.nama`,
      [query.status ?? null, query.q?.replace(/[%_\\]/g, (c) => `\\${c}`) ?? null],
    );
    return result.rows;
  }

  async detail(id: string): Promise<PsikologAdmin> {
    const result = await this.pool.query<PsikologAdmin>(`SELECT ${KOLOM} FROM psikolog p WHERE p.id_psikolog = $1`, [id]);
    if (!result.rows[0]) throw this.notFound();
    return result.rows[0];
  }

  async buat(admin: AuthenticatedUser, dto: BuatPsikologDto, ctx: Ctx) {
    const password = passwordSementara();
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    return denganTransaksi(this.pool, async (client) => {
      let id: string;
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO psikolog (nama, email, password_hash, status_akun, wajib_ganti_password)
           VALUES ($1, $2, $3, 'MENUNGGU_VERIFIKASI', true)
           RETURNING id_psikolog::text AS id`,
          [dto.nama, dto.email, hash],
        );
        id = result.rows[0].id;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw this.emailTerpakai();
        throw error;
      }
      await this.catat(client, admin, 'AKUN_PSIKOLOG_BUAT', id, ctx);
      const psikolog = await this.detailDengan(client, id);
      return { psikolog, password_sementara: password };
    });
  }

  async ubah(admin: AuthenticatedUser, id: string, dto: UbahPsikologDto, ctx: Ctx): Promise<PsikologAdmin> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (dto.nama !== undefined) { values.push(dto.nama); sets.push(`nama = $${values.length}`); }
    if (dto.email !== undefined) { values.push(dto.email); sets.push(`email = $${values.length}`); }
    if (sets.length === 0) return this.detail(id);
    return denganTransaksi(this.pool, async (client) => {
      try {
        const result = await client.query(`UPDATE psikolog SET ${sets.join(', ')} WHERE id_psikolog = $1`, values);
        if (result.rowCount !== 1) throw this.notFound();
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw this.emailTerpakai();
        throw error;
      }
      await this.catat(client, admin, 'AKUN_PSIKOLOG_UBAH', id, ctx, {
        field: sets.map((s) => s.split(' = ')[0]),
      });
      return this.detailDengan(client, id);
    });
  }

  async aktifkan(admin: AuthenticatedUser, id: string, ctx: Ctx): Promise<PsikologAdmin> {
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE psikolog SET status_akun = 'AKTIF', diverifikasi_oleh = $2, diverifikasi_at = now()
         WHERE id_psikolog = $1 AND status_akun <> 'AKTIF'`,
        [id, admin.id],
      );
      if (result.rowCount === 1) await this.catat(client, admin, 'AKUN_PSIKOLOG_AKTIFKAN', id, ctx);
      return this.detailDengan(client, id);
    });
  }

  /**
   * Nonaktifkan psikolog. Demi keselamatan mahasiswa, kasus SOS yang sedang dipegang
   * dikembalikan ke antrean sebagai ESKALASI (prioritas perhatian tertinggi) dan disiarkan
   * ke semua psikolog aktif; jadwal jaga mendatang dihapus; sesi & koneksi realtime diputus.
   */
  async nonaktifkan(admin: AuthenticatedUser, id: string, ctx: Ctx) {
    const hasil = await denganTransaksi(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE psikolog SET status_akun = 'NONAKTIF', status_jaga = false
         WHERE id_psikolog = $1 AND status_akun <> 'NONAKTIF'`,
        [id],
      );
      if (updated.rowCount !== 1) {
        await this.detailDengan(client, id); // 404 bila tidak ada
        return { berubah: false, kasus: [], jadwal_dihapus: 0 };
      }
      const kasus = await client.query<{
        id_sos: string; prioritas: string; situasi: string | null; lokasi_izin: boolean;
        perlu_verifikasi: boolean; waktu_kejadian: Date;
      }>(
        `UPDATE log_sos
         SET status_penanganan = 'ESKALASI', id_psikolog = NULL, waktu_diambil = NULL,
             waktu_eskalasi = COALESCE(waktu_eskalasi, now()),
             -- Kasus ini sudah sempat ditangani: tidak memicu SMS "belum direspons" ke kampus/keluarga.
             -- Semua psikolog aktif dikabari lewat sos:eskalasi di bawah (keputusan PBI-09 §4).
             tindakan_eskalasi_at = COALESCE(tindakan_eskalasi_at, now())
         WHERE id_psikolog = $1 AND status_penanganan IN ('DIAMBIL', 'DITANGANI')
         RETURNING id_sos::text AS id_sos, prioritas, situasi, lokasi_izin, perlu_verifikasi, waktu_kejadian`,
        [id],
      );
      const jadwal = await client.query(
        `DELETE FROM jadwal_jaga
         WHERE id_psikolog = $1 AND (tanggal + jam_selesai) > (now() AT TIME ZONE $2)`,
        [id, zonaWaktuJadwal()],
      );
      await client.query(
        `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
         WHERE id_pengguna = $1 AND role = 'PSIKOLOG'`,
        [id],
      );
      await this.catat(client, admin, 'AKUN_PSIKOLOG_NONAKTIFKAN', id, ctx, {
        kasus_dikembalikan: kasus.rowCount ?? 0,
        jadwal_dihapus: jadwal.rowCount ?? 0,
      });
      return { berubah: true, kasus: kasus.rows, jadwal_dihapus: jadwal.rowCount ?? 0 };
    });

    if (hasil.berubah) {
      this.gateway.putuskanPsikolog(id);
      for (const sos of hasil.kasus) {
        this.notifikasi.sosDiperbarui({ id_sos: sos.id_sos, status_penanganan: 'ESKALASI', id_psikolog: null });
        await this.notifikasi.sosEskalasi({
          id_sos: sos.id_sos,
          prioritas: sos.prioritas as never,
          situasi: sos.situasi,
          waktu_kejadian: new Date(sos.waktu_kejadian).toISOString(),
          waktu_eskalasi: new Date().toISOString(),
          lokasi_tersedia: sos.lokasi_izin,
          perlu_verifikasi: sos.perlu_verifikasi,
          sumber: 'PENANGAN_NONAKTIF',
        });
      }
      if (hasil.kasus.length) {
        this.logger.warn(`${hasil.kasus.length} kasus SOS dikembalikan ke antrean karena psikolog ${id} dinonaktifkan`);
      }
    }
    return {
      psikolog: await this.detail(id),
      kasus_dikembalikan: hasil.kasus.length,
      jadwal_dihapus: hasil.jadwal_dihapus,
    };
  }

  /** Password sementara baru (sekali tampil); semua sesi psikolog dicabut. */
  async resetPassword(admin: AuthenticatedUser, id: string, ctx: Ctx) {
    const password = passwordSementara();
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    await denganTransaksi(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE psikolog SET password_hash = $2, wajib_ganti_password = true WHERE id_psikolog = $1`,
        [id, hash],
      );
      if (result.rowCount !== 1) throw this.notFound();
      await client.query(
        `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
         WHERE id_pengguna = $1 AND role = 'PSIKOLOG'`,
        [id],
      );
      await this.catat(client, admin, 'AKUN_PSIKOLOG_RESET_PASSWORD', id, ctx);
    });
    // Password sementara wajib diganti dulu: koneksi realtime yang masih hidup diputus sekarang
    // (tidak menunggu pemeriksaan ulang berkala).
    this.gateway.putuskanPsikolog(id);
    return { password_sementara: password };
  }

  private async detailDengan(client: PoolClient, id: string): Promise<PsikologAdmin> {
    const result = await client.query<PsikologAdmin>(`SELECT ${KOLOM} FROM psikolog p WHERE p.id_psikolog = $1`, [id]);
    if (!result.rows[0]) throw this.notFound();
    return result.rows[0];
  }

  private catat(
    client: PoolClient,
    admin: AuthenticatedUser,
    aksi: string,
    id: string,
    ctx: Ctx,
    metadata?: Record<string, unknown>,
  ) {
    return this.audit.catat({
      aktor: admin, aksi, resourceType: 'psikolog', resourceId: id,
      ip: ctx.ip, userAgent: ctx.userAgent, metadata,
    }, client);
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ kode: 'PSIKOLOG_TIDAK_DITEMUKAN', pesan: 'Psikolog tidak ditemukan' });
  }

  private emailTerpakai(): ConflictException {
    return new ConflictException({ kode: 'EMAIL_SUDAH_TERDAFTAR', pesan: 'Email sudah dipakai akun psikolog lain' });
  }
}
