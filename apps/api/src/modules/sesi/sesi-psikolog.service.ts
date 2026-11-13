import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { EncryptionService } from '../../common/crypto/encryption.service';
import {
  aadSesi,
  SQL_STATUS_SESI_AKTIF,
  SQL_STATUS_SESI_RIWAYAT,
  StatusSesi,
  TipeSesi,
} from '../../common/domain/sesi';
import { CakupanSesiPsikolog, DaftarSesiPsikologQuery, UbahStatusSesiDto } from './sesi.dto';
import { sesiConfig } from './sesi.constants';

export interface KonteksPermintaan {
  ip?: string;
  userAgent?: string;
}

export interface SesiPsikolog {
  id_sesi: string;
  waktu_mulai: Date;
  waktu_selesai: Date;
  tipe_sesi: TipeSesi;
  status_sesi: StatusSesi;
  consent_catatan: boolean;
  alasan_batal: string | null;
  mahasiswa: { id: string; nama: string };
}

export interface DetailSesiPsikolog extends SesiPsikolog {
  mahasiswa: { id: string; nama: string; nim: string };
  keluhan_awal: string | null;
  ada_ringkasan: boolean;
}

interface SesiRow {
  id_sesi: string;
  waktu_mulai: Date;
  waktu_selesai: Date;
  tipe_sesi: TipeSesi;
  status_sesi: StatusSesi;
  consent_catatan: boolean;
  alasan_batal: string | null;
  id_mahasiswa: string;
  nama_mahasiswa: string;
}

export interface StatusSesiBaru {
  id_sesi: string;
  status_sesi: StatusSesi;
  waktu_mulai: Date;
  waktu_selesai: Date;
}

const KOLOM = `s.id_sesi::text AS id_sesi, s.waktu_mulai, s.waktu_selesai, s.tipe_sesi, s.status_sesi,
  s.consent_catatan, s.alasan_batal, s.id_mahasiswa::text AS id_mahasiswa,
  COALESCE(m.nama_tampilan, m.nama) AS nama_mahasiswa`;

const FILTER: Record<CakupanSesiPsikolog, { where: string; order: string }> = {
  mendatang: { where: `s.status_sesi IN ${SQL_STATUS_SESI_AKTIF}`, order: 's.waktu_mulai ASC' },
  riwayat: { where: `s.status_sesi IN ${SQL_STATUS_SESI_RIWAYAT}`, order: 's.waktu_mulai DESC' },
  semua: { where: 'true', order: 's.waktu_mulai DESC' },
};

/**
 * Transisi status oleh psikolog (FR-PSI-04). Kondisi waktu ditegakkan di SQL agar
 * pengecekan dan perubahan atomik:
 * - DIJADWALKAN → BERLANGSUNG: mulai paling cepat `SESI_MULAI_LEBIH_AWAL_MENIT` sebelum jadwal, sebelum jadwal berakhir;
 * - BERLANGSUNG → SELESAI;
 * - DIJADWALKAN → TIDAK_HADIR: setelah jadwal mulai (mahasiswa tidak datang).
 */
const TRANSISI: Record<UbahStatusSesiDto['status'], {
  dari: StatusSesi;
  syarat: string;
  /** Parameter tambahan untuk `syarat` (dimulai dari $5). */
  params: () => unknown[];
}> = {
  BERLANGSUNG: {
    dari: 'DIJADWALKAN',
    syarat: `now() >= s.waktu_mulai - make_interval(mins => $5::int) AND now() < s.waktu_selesai`,
    params: () => [sesiConfig.mulaiLebihAwalMenit()],
  },
  SELESAI: { dari: 'BERLANGSUNG', syarat: 'true', params: () => [] },
  TIDAK_HADIR: { dari: 'DIJADWALKAN', syarat: 'now() >= s.waktu_mulai', params: () => [] },
};

/** Jadwal & pelaksanaan sesi oleh psikolog (PBI-11, FR-PSI-04). */
@Injectable()
export class SesiPsikologService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async daftar(psikolog: AuthenticatedUser, query: DaftarSesiPsikologQuery): Promise<SesiPsikolog[]> {
    const { where, order } = FILTER[query.cakupan ?? 'mendatang'];
    const result = await this.pool.query<SesiRow>(
      `SELECT ${KOLOM}
       FROM sesi_konseling s JOIN mahasiswa m ON m.id_mahasiswa = s.id_mahasiswa
       WHERE s.id_psikolog = $1 AND ${where}
       ORDER BY ${order}
       LIMIT $2`,
      [psikolog.id, query.limit ?? 50],
    );
    return result.rows.map((row) => this.toDto(row));
  }

  /** Detail sesi milik psikolog ini, termasuk keluhan awal terdekripsi (diaudit `SESI_DETAIL_READ`). */
  async detail(psikolog: AuthenticatedUser, idSesi: string, ctx: KonteksPermintaan): Promise<DetailSesiPsikolog> {
    const result = await this.pool.query<SesiRow & { nim: string; keluhan_awal_enc: Buffer | null; ada_ringkasan: boolean }>(
      `SELECT ${KOLOM}, m.nim, s.keluhan_awal_enc, (s.catatan_ringkasan_enc IS NOT NULL) AS ada_ringkasan
       FROM sesi_konseling s JOIN mahasiswa m ON m.id_mahasiswa = s.id_mahasiswa
       WHERE s.id_sesi = $1 AND s.id_psikolog = $2`,
      [idSesi, psikolog.id],
    );
    const row = result.rows[0];
    if (!row) throw this.sesiTidakDitemukan();
    await this.audit.catat({
      aktor: psikolog, aksi: 'SESI_DETAIL_READ', resourceType: 'sesi_konseling', resourceId: idSesi,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    const { nim, keluhan_awal_enc, ada_ringkasan, ...sesi } = row;
    const dto = this.toDto(sesi);
    return {
      ...dto,
      mahasiswa: { ...dto.mahasiswa, nim },
      keluhan_awal: keluhan_awal_enc
        ? this.encryption.decrypt(keluhan_awal_enc, aadSesi('keluhan_awal_enc', idSesi)).toString('utf8')
        : null,
      ada_ringkasan,
    };
  }

  async ubahStatus(
    psikolog: AuthenticatedUser,
    idSesi: string,
    dto: UbahStatusSesiDto,
    ctx: KonteksPermintaan,
  ): Promise<StatusSesiBaru> {
    const transisi = TRANSISI[dto.status];
    return denganTransaksi(this.pool, async (client) => {
      const result = await client.query<StatusSesiBaru>(
        `UPDATE sesi_konseling s SET status_sesi = $3::status_sesi
         WHERE s.id_sesi = $1 AND s.id_psikolog = $2 AND s.status_sesi = $4::status_sesi AND ${transisi.syarat}
         RETURNING s.id_sesi::text AS id_sesi, s.status_sesi, s.waktu_mulai, s.waktu_selesai`,
        [idSesi, psikolog.id, dto.status, transisi.dari, ...transisi.params()],
      );
      const updated = result.rows[0];
      if (!updated) throw await this.alasanDitolak(client, psikolog, idSesi, dto.status);
      await this.audit.catat({
        aktor: psikolog, aksi: 'SESI_STATUS_UBAH', resourceType: 'sesi_konseling', resourceId: idSesi,
        ip: ctx.ip, userAgent: ctx.userAgent, metadata: { status: dto.status },
      }, client);
      return updated;
    });
  }

  private async alasanDitolak(
    client: PoolClient,
    psikolog: AuthenticatedUser,
    idSesi: string,
    target: UbahStatusSesiDto['status'],
  ): Promise<Error> {
    const result = await client.query<{ status_sesi: StatusSesi }>(
      `SELECT status_sesi FROM sesi_konseling WHERE id_sesi = $1 AND id_psikolog = $2`,
      [idSesi, psikolog.id],
    );
    const status = result.rows[0]?.status_sesi;
    if (!status) return this.sesiTidakDitemukan();
    if (status === target) {
      return new ConflictException({ kode: 'STATUS_SUDAH_SAMA', pesan: `Sesi sudah berstatus ${target}` });
    }
    if (status !== TRANSISI[target].dari) {
      return new ConflictException({
        kode: 'TRANSISI_TIDAK_VALID',
        pesan: `Status ${status} tidak dapat diubah menjadi ${target}`,
      });
    }
    return new UnprocessableEntityException({
      kode: 'DI_LUAR_WAKTU_SESI',
      pesan: target === 'BERLANGSUNG'
        ? 'Sesi hanya dapat dimulai menjelang jadwal dan sebelum jadwal berakhir'
        : 'Mahasiswa baru dapat ditandai tidak hadir setelah jadwal sesi dimulai',
    });
  }

  private toDto(row: SesiRow): SesiPsikolog {
    const { id_mahasiswa, nama_mahasiswa, ...rest } = row;
    return { ...rest, mahasiswa: { id: id_mahasiswa, nama: nama_mahasiswa } };
  }

  private sesiTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'SESI_TIDAK_DITEMUKAN', pesan: 'Sesi tidak ditemukan' });
  }
}
