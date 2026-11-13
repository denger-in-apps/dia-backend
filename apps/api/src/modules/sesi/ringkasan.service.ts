import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { aadSesi, StatusSesi, TipeSesi } from '../../common/domain/sesi';
import { KonteksPermintaan } from './sesi-psikolog.service';

export interface Consent {
  id_sesi: string;
  consent_catatan: boolean;
  consent_at: Date | null;
}

export interface Ringkasan {
  id_sesi: string;
  ringkasan: string;
  updated_at: Date;
}

export interface MahasiswaDampingan {
  id: string;
  nama: string;
  jumlah_sesi: number;
  sesi_terakhir: Date;
}

export interface RiwayatSesi {
  id_sesi: string;
  waktu_mulai: Date;
  waktu_selesai: Date;
  tipe_sesi: TipeSesi;
  status_sesi: StatusSesi;
  nama_psikolog: string;
  milik_saya: boolean;
  consent_catatan: boolean;
  /** Hanya untuk sesi psikolog ini yang disetujui mahasiswa; sesi psikolog lain selalu `null`. */
  ringkasan: string | null;
}

/** Status sesi yang boleh memiliki ringkasan. */
const STATUS_RINGKASAN: StatusSesi[] = ['BERLANGSUNG', 'SELESAI'];
/** Consent dapat diatur selama sesi belum dibatalkan / tidak hadir. */
const STATUS_CONSENT: StatusSesi[] = ['DIJADWALKAN', 'BERLANGSUNG', 'SELESAI'];
/** Psikolog "pernah menangani" mahasiswa bila punya sesi berjalan/selesai dengannya. */
const SQL_PERNAH_DITANGANI = `('BERLANGSUNG', 'SELESAI')`;

/**
 * Ringkasan & riwayat sesi (PBI-13, FR-PSI-05/FR-PSI-08, NFR-04).
 *
 * Ringkasan hanya dapat disimpan bila mahasiswa memberi consent (`consent_catatan`).
 * Ini juga dijamin CHECK `sesi_ringkasan_butuh_consent` di DB. Menarik consent
 * menghapus ringkasan. Ringkasan dienkripsi AES-256-GCM dengan AAD per baris, dan setiap
 * tulis/baca dicatat di audit log.
 */
@Injectable()
export class RingkasanService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  /** Mahasiswa memberi/menarik consent pencatatan ringkasan untuk sesinya. */
  async aturConsent(mahasiswa: AuthenticatedUser, idSesi: string, setuju: boolean, ctx: KonteksPermintaan): Promise<Consent> {
    return denganTransaksi(this.pool, async (client) => {
      const current = await client.query<{ status_sesi: StatusSesi; consent_catatan: boolean }>(
        `SELECT status_sesi, consent_catatan FROM sesi_konseling
         WHERE id_sesi = $1 AND id_mahasiswa = $2 FOR UPDATE`,
        [idSesi, mahasiswa.id],
      );
      const sesi = current.rows[0];
      if (!sesi) throw this.sesiTidakDitemukan();
      if (!STATUS_CONSENT.includes(sesi.status_sesi)) {
        throw new ConflictException({
          kode: 'SESI_TIDAK_DAPAT_DIUBAH',
          pesan: `Consent tidak dapat diatur untuk sesi berstatus ${sesi.status_sesi}`,
        });
      }
      const result = await client.query<Consent>(
        `UPDATE sesi_konseling
         SET consent_catatan = $2, consent_at = now(),
             catatan_ringkasan_enc = CASE WHEN $2 THEN catatan_ringkasan_enc END
         WHERE id_sesi = $1
         RETURNING id_sesi::text AS id_sesi, consent_catatan, consent_at`,
        [idSesi, setuju],
      );
      if (sesi.consent_catatan !== setuju) {
        await this.audit.catat({
          aktor: mahasiswa, aksi: setuju ? 'SESI_CONSENT_BERI' : 'SESI_CONSENT_TARIK',
          resourceType: 'sesi_konseling', resourceId: idSesi, ip: ctx.ip, userAgent: ctx.userAgent,
        }, client);
      }
      return result.rows[0];
    });
  }

  /** Psikolog sesi menulis/memperbarui ringkasan; `403 CONSENT_BELUM_ADA` tanpa consent. */
  async simpan(psikolog: AuthenticatedUser, idSesi: string, ringkasan: string, ctx: KonteksPermintaan): Promise<Ringkasan> {
    const enc = this.encryption.encrypt(ringkasan, aadSesi('catatan_ringkasan_enc', idSesi));
    return denganTransaksi(this.pool, async (client) => {
      // Kunci baris: penarikan consent oleh mahasiswa yang bersamaan menunggu, bukan tertimpa.
      const current = await client.query<{ status_sesi: StatusSesi; consent_catatan: boolean; ada: boolean }>(
        `SELECT status_sesi, consent_catatan, (catatan_ringkasan_enc IS NOT NULL) AS ada
         FROM sesi_konseling WHERE id_sesi = $1 AND id_psikolog = $2 FOR UPDATE`,
        [idSesi, psikolog.id],
      );
      const sesi = current.rows[0];
      if (!sesi) throw this.sesiTidakDitemukan();
      if (!sesi.consent_catatan) throw this.consentBelumAda();
      if (!STATUS_RINGKASAN.includes(sesi.status_sesi)) {
        throw new ConflictException({
          kode: 'SESI_BELUM_BERLANGSUNG',
          pesan: 'Ringkasan hanya dapat dicatat untuk sesi yang berlangsung atau selesai',
        });
      }
      const result = await client.query<{ updated_at: Date }>(
        `UPDATE sesi_konseling SET catatan_ringkasan_enc = $2 WHERE id_sesi = $1 RETURNING updated_at`,
        [idSesi, enc],
      );
      await this.audit.catat({
        aktor: psikolog, aksi: sesi.ada ? 'SESI_RINGKASAN_UPDATE' : 'SESI_RINGKASAN_CREATE',
        resourceType: 'sesi_konseling', resourceId: idSesi, ip: ctx.ip, userAgent: ctx.userAgent,
      }, client);
      return { id_sesi: idSesi, ringkasan, updated_at: result.rows[0].updated_at };
    });
  }

  async baca(psikolog: AuthenticatedUser, idSesi: string, ctx: KonteksPermintaan): Promise<Ringkasan> {
    const result = await this.pool.query<{ consent_catatan: boolean; catatan_ringkasan_enc: Buffer | null; updated_at: Date }>(
      `SELECT consent_catatan, catatan_ringkasan_enc, updated_at
       FROM sesi_konseling WHERE id_sesi = $1 AND id_psikolog = $2`,
      [idSesi, psikolog.id],
    );
    const row = result.rows[0];
    if (!row) throw this.sesiTidakDitemukan();
    if (!row.consent_catatan) throw this.consentBelumAda();
    if (!row.catatan_ringkasan_enc) {
      throw new NotFoundException({ kode: 'RINGKASAN_BELUM_ADA', pesan: 'Ringkasan sesi belum dicatat' });
    }
    await this.audit.catat({
      aktor: psikolog, aksi: 'SESI_RINGKASAN_READ', resourceType: 'sesi_konseling', resourceId: idSesi,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { id_sesi: idSesi, ringkasan: this.dekripsi(idSesi, row.catatan_ringkasan_enc), updated_at: row.updated_at };
  }

  /** Mahasiswa yang pernah ditangani psikolog ini (sesi BERLANGSUNG/SELESAI), terbaru dulu. */
  async daftarDampingan(psikolog: AuthenticatedUser): Promise<MahasiswaDampingan[]> {
    const result = await this.pool.query<MahasiswaDampingan>(
      `SELECT m.id_mahasiswa::text AS id, COALESCE(m.nama_tampilan, m.nama) AS nama,
              count(*)::int AS jumlah_sesi, max(s.waktu_mulai) AS sesi_terakhir
       FROM sesi_konseling s JOIN mahasiswa m ON m.id_mahasiswa = s.id_mahasiswa
       WHERE s.id_psikolog = $1 AND s.status_sesi IN ${SQL_PERNAH_DITANGANI}
       GROUP BY m.id_mahasiswa
       ORDER BY max(s.waktu_mulai) DESC
       LIMIT 200`,
      [psikolog.id],
    );
    return result.rows;
  }

  /**
   * Riwayat sesi seorang mahasiswa (FR-PSI-08), hanya bila psikolog ini pernah menanganinya
   * (selain itu `403`). Sesi dengan psikolog lain ditampilkan sebagai metadata saja; ringkasan
   * hanya dari sesi milik psikolog ini yang disetujui mahasiswa. Diaudit `RIWAYAT_SESI_READ`.
   */
  async riwayatMahasiswa(psikolog: AuthenticatedUser, idMahasiswa: string, ctx: KonteksPermintaan): Promise<RiwayatSesi[]> {
    const pernah = await this.pool.query(
      `SELECT 1 FROM sesi_konseling
       WHERE id_psikolog = $1 AND id_mahasiswa = $2 AND status_sesi IN ${SQL_PERNAH_DITANGANI} LIMIT 1`,
      [psikolog.id, idMahasiswa],
    );
    if (!pernah.rowCount) {
      await this.audit.catat({
        aktor: psikolog, aksi: 'RIWAYAT_SESI_READ', resourceType: 'mahasiswa', resourceId: idMahasiswa,
        hasil: 'DITOLAK', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { alasan: 'BUKAN_MAHASISWA_DAMPINGAN' },
      });
      throw new ForbiddenException({
        kode: 'BUKAN_MAHASISWA_DAMPINGAN',
        pesan: 'Riwayat hanya tersedia untuk mahasiswa yang pernah Anda tangani',
      });
    }
    const result = await this.pool.query<Omit<RiwayatSesi, 'ringkasan'> & { catatan_ringkasan_enc: Buffer | null }>(
      `SELECT s.id_sesi::text AS id_sesi, s.waktu_mulai, s.waktu_selesai, s.tipe_sesi, s.status_sesi,
              p.nama AS nama_psikolog, (s.id_psikolog = $1::uuid) AS milik_saya, s.consent_catatan,
              CASE WHEN s.id_psikolog = $1::uuid AND s.consent_catatan THEN s.catatan_ringkasan_enc END
                AS catatan_ringkasan_enc
       FROM sesi_konseling s JOIN psikolog p ON p.id_psikolog = s.id_psikolog
       WHERE s.id_mahasiswa = $2
       ORDER BY s.waktu_mulai DESC
       LIMIT 200`,
      [psikolog.id, idMahasiswa],
    );
    await this.audit.catat({
      aktor: psikolog, aksi: 'RIWAYAT_SESI_READ', resourceType: 'mahasiswa', resourceId: idMahasiswa,
      ip: ctx.ip, userAgent: ctx.userAgent, metadata: { jumlah_sesi: result.rows.length },
    });
    return result.rows.map(({ catatan_ringkasan_enc, ...row }) => ({
      ...row,
      ringkasan: catatan_ringkasan_enc ? this.dekripsi(row.id_sesi, catatan_ringkasan_enc) : null,
    }));
  }

  private dekripsi(idSesi: string, enc: Buffer): string {
    return this.encryption.decrypt(enc, aadSesi('catatan_ringkasan_enc', idSesi)).toString('utf8');
  }

  private consentBelumAda(): ForbiddenException {
    return new ForbiddenException({
      kode: 'CONSENT_BELUM_ADA',
      pesan: 'Mahasiswa belum menyetujui pencatatan ringkasan sesi ini',
    });
  }

  private sesiTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'SESI_TIDAK_DITEMUKAN', pesan: 'Sesi tidak ditemukan' });
  }
}
