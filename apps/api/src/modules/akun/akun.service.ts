import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AuditService } from '../../common/audit/audit.service';
import { SQL_STATUS_SOS_AKTIF } from '../../common/domain/sos';
import { CreateKontakDaruratDto, UpdateKontakDaruratDto, UpdateProfilDto } from './akun.dto';
import {
  EksporDataMahasiswa,
  KontakDarurat,
  ProfilMahasiswa,
  RequestContext,
} from './akun.types';

export const MAKS_KONTAK_DARURAT = 5;

const PROFIL_COLUMNS = `id_mahasiswa::text AS id, nim, nama, nama_tampilan, email::text AS email,
  status_aktif, terakhir_verifikasi_at, created_at, updated_at`;

interface KontakRow {
  id: string;
  nama_kontak: string;
  no_telepon_enc: Buffer;
  hubungan: string | null;
  created_at: Date;
}

/**
 * PBI-03 / FR-MHS-12: mahasiswa melihat, mengubah, mengekspor, dan menghapus
 * data miliknya. Semua query dibatasi `id_mahasiswa` dari token (bukan dari klien).
 */
@Injectable()
export class AkunService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async profil(idMahasiswa: string): Promise<ProfilMahasiswa> {
    const result = await this.pool.query<ProfilMahasiswa>(
      `SELECT ${PROFIL_COLUMNS} FROM mahasiswa WHERE id_mahasiswa = $1 AND deleted_at IS NULL`,
      [idMahasiswa],
    );
    const profil = result.rows[0];
    if (!profil) throw new NotFoundException({ kode: 'AKUN_TIDAK_DITEMUKAN', pesan: 'Akun tidak ditemukan' });
    return profil;
  }

  async ubahProfil(idMahasiswa: string, dto: UpdateProfilDto): Promise<ProfilMahasiswa> {
    if (dto.nama_tampilan === undefined) return this.profil(idMahasiswa);
    const result = await this.pool.query<ProfilMahasiswa>(
      `UPDATE mahasiswa SET nama_tampilan = $2
       WHERE id_mahasiswa = $1 AND deleted_at IS NULL
       RETURNING ${PROFIL_COLUMNS}`,
      [idMahasiswa, dto.nama_tampilan],
    );
    const profil = result.rows[0];
    if (!profil) throw new NotFoundException({ kode: 'AKUN_TIDAK_DITEMUKAN', pesan: 'Akun tidak ditemukan' });
    return profil;
  }

  async daftarKontak(idMahasiswa: string): Promise<KontakDarurat[]> {
    const result = await this.pool.query<KontakRow>(
      `SELECT id_kontak::text AS id, nama_kontak, no_telepon_enc, hubungan, created_at
       FROM kontak_darurat WHERE id_mahasiswa = $1 ORDER BY created_at, id_kontak`,
      [idMahasiswa],
    );
    return result.rows.map((row) => this.toKontak(row));
  }

  async tambahKontak(idMahasiswa: string, dto: CreateKontakDaruratDto): Promise<KontakDarurat> {
    return this.inTransaction(async (client) => {
      // Kunci baris mahasiswa agar batas jumlah kontak tidak terlewati oleh request paralel.
      await this.lockMahasiswa(client, idMahasiswa);
      const count = await client.query<{ jumlah: number }>(
        `SELECT count(*)::int AS jumlah FROM kontak_darurat WHERE id_mahasiswa = $1`,
        [idMahasiswa],
      );
      if (count.rows[0].jumlah >= MAKS_KONTAK_DARURAT) {
        throw new UnprocessableEntityException({
          kode: 'KONTAK_DARURAT_PENUH',
          pesan: `Maksimal ${MAKS_KONTAK_DARURAT} kontak darurat`,
        });
      }
      const id = randomUUID();
      const result = await client.query<KontakRow>(
        `INSERT INTO kontak_darurat (id_kontak, nama_kontak, no_telepon_enc, hubungan, id_mahasiswa)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id_kontak::text AS id, nama_kontak, no_telepon_enc, hubungan, created_at`,
        [id, dto.nama_kontak, this.encryptPhone(id, dto.no_telepon), dto.hubungan ?? null, idMahasiswa],
      );
      return this.toKontak(result.rows[0]);
    });
  }

  async ubahKontak(
    idMahasiswa: string,
    idKontak: string,
    dto: UpdateKontakDaruratDto,
  ): Promise<KontakDarurat> {
    const sets: string[] = [];
    const values: unknown[] = [idKontak, idMahasiswa];
    if (dto.nama_kontak !== undefined) {
      values.push(dto.nama_kontak);
      sets.push(`nama_kontak = $${values.length}`);
    }
    if (dto.no_telepon !== undefined) {
      values.push(this.encryptPhone(idKontak, dto.no_telepon));
      sets.push(`no_telepon_enc = $${values.length}`);
    }
    if (dto.hubungan !== undefined) {
      values.push(dto.hubungan);
      sets.push(`hubungan = $${values.length}`);
    }

    const result = sets.length
      ? await this.pool.query<KontakRow>(
        `UPDATE kontak_darurat SET ${sets.join(', ')}
         WHERE id_kontak = $1 AND id_mahasiswa = $2
         RETURNING id_kontak::text AS id, nama_kontak, no_telepon_enc, hubungan, created_at`,
        values,
      )
      : await this.pool.query<KontakRow>(
        `SELECT id_kontak::text AS id, nama_kontak, no_telepon_enc, hubungan, created_at
         FROM kontak_darurat WHERE id_kontak = $1 AND id_mahasiswa = $2`,
        values,
      );
    const row = result.rows[0];
    if (!row) throw this.kontakNotFound();
    return this.toKontak(row);
  }

  async hapusKontak(idMahasiswa: string, idKontak: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM kontak_darurat WHERE id_kontak = $1 AND id_mahasiswa = $2`,
      [idKontak, idMahasiswa],
    );
    if (result.rowCount !== 1) throw this.kontakNotFound();
  }

  async ekspor(idMahasiswa: string, context: RequestContext): Promise<EksporDataMahasiswa> {
    const profil = await this.profil(idMahasiswa);
    const [kontak, minat, sos, cek, sesi, curhat, circle] = await Promise.all([
      this.daftarKontak(idMahasiswa),
      this.pool.query(
        `SELECT k.id_kategori::text AS id_kategori, k.nama
         FROM preferensi_minat p JOIN kategori_minat k ON k.id_kategori = p.id_kategori
         WHERE p.id_mahasiswa = $1 ORDER BY k.nama`,
        [idMahasiswa],
      ),
      this.pool.query(
        `SELECT id_sos::text AS id_sos, waktu_kejadian, situasi, prioritas, status_penanganan,
                lokasi_izin, waktu_diambil, waktu_selesai
         FROM log_sos WHERE id_mahasiswa = $1 ORDER BY waktu_kejadian DESC`,
        [idMahasiswa],
      ),
      this.pool.query(
        `SELECT id_cek::text AS id_cek, waktu_tes, skor_phq9, skor_gad7, risiko_phq9, risiko_gad7,
                butir9_positif, rekomendasi
         FROM hasil_cek_mandiri WHERE id_mahasiswa = $1 ORDER BY waktu_tes DESC`,
        [idMahasiswa],
      ),
      this.pool.query(
        `SELECT id_sesi::text AS id_sesi, waktu_mulai, waktu_selesai, tipe_sesi, status_sesi,
                consent_catatan, alasan_batal
         FROM sesi_konseling WHERE id_mahasiswa = $1 ORDER BY waktu_mulai DESC`,
        [idMahasiswa],
      ),
      this.pool.query(
        `SELECT id_curhat::text AS id_curhat, waktu_curhat, status, alias_anonim
         FROM curhat_anonim WHERE id_mahasiswa = $1 ORDER BY waktu_curhat DESC`,
        [idMahasiswa],
      ),
      this.pool.query(
        `SELECT a.id_circle::text AS id_circle, c.nama_circle, a.alias_anonim, a.status_anonim, a.joined_at
         FROM keanggotaan_circle a JOIN circle c ON c.id_circle = a.id_circle
         WHERE a.id_mahasiswa = $1 ORDER BY a.joined_at DESC`,
        [idMahasiswa],
      ),
    ]);

    await this.audit.catat({
      aktor: { id: idMahasiswa, role: 'MAHASISWA' },
      aksi: 'DATA_EKSPOR',
      resourceType: 'mahasiswa',
      resourceId: idMahasiswa,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      diekspor_at: new Date().toISOString(),
      catatan:
        'Ekspor memuat data milik Anda. Isi terenkripsi milik layanan lain (mis. pesan sesi E2EE, ' +
        'ringkasan sesi psikolog) tidak disertakan.',
      profil,
      kontak_darurat: kontak,
      preferensi_minat: minat.rows,
      riwayat_sos: sos.rows,
      riwayat_cek_mandiri: cek.rows,
      riwayat_sesi: sesi.rows,
      riwayat_curhat: curhat.rows,
      keanggotaan_circle: circle.rows,
    };
  }

  /**
   * Hapus akun = soft delete + anonimisasi (04-database.md §1.6 dan §10): data pribadi
   * dihapus, baris yang dibutuhkan statistik/audit dipertahankan tanpa identitas.
   * Ditolak selama mahasiswa masih punya SOS yang berjalan (fitur keselamatan).
   */
  async hapusAkun(idMahasiswa: string, context: RequestContext): Promise<void> {
    await this.inTransaction(async (client) => {
      await this.lockMahasiswa(client, idMahasiswa);

      const sosAktif = await client.query(
        `SELECT 1 FROM log_sos
         WHERE id_mahasiswa = $1 AND status_penanganan IN ${SQL_STATUS_SOS_AKTIF} LIMIT 1`,
        [idMahasiswa],
      );
      if (sosAktif.rowCount) {
        throw new ConflictException({
          kode: 'SOS_AKTIF',
          pesan: 'Akun tidak dapat dihapus selama permintaan SOS Anda masih ditangani',
        });
      }

      await client.query(
        `UPDATE sesi_konseling
         SET status_sesi = 'DIBATALKAN', alasan_batal = 'Akun mahasiswa dihapus'
         WHERE id_mahasiswa = $1 AND status_sesi IN ('DIJADWALKAN', 'BERLANGSUNG')`,
        [idMahasiswa],
      );
      await client.query(
        `UPDATE sesi_konseling SET keluhan_awal_enc = NULL WHERE id_mahasiswa = $1`,
        [idMahasiswa],
      );
      await client.query(`DELETE FROM kontak_darurat WHERE id_mahasiswa = $1`, [idMahasiswa]);
      await client.query(`DELETE FROM preferensi_minat WHERE id_mahasiswa = $1`, [idMahasiswa]);
      await client.query(`DELETE FROM keanggotaan_circle WHERE id_mahasiswa = $1`, [idMahasiswa]);
      await client.query(`DELETE FROM curhat_anonim WHERE id_mahasiswa = $1`, [idMahasiswa]);
      await client.query(
        `DELETE FROM kunci_e2ee WHERE id_pengguna = $1 AND role = 'MAHASISWA'`,
        [idMahasiswa],
      );
      await client.query(
        `DELETE FROM notifikasi WHERE id_penerima = $1 AND role = 'MAHASISWA'`,
        [idMahasiswa],
      );
      // Skor agregat dipertahankan untuk laporan anonim; jawaban rinci dihapus.
      await client.query(
        `UPDATE hasil_cek_mandiri SET jawaban_enc = NULL WHERE id_mahasiswa = $1`,
        [idMahasiswa],
      );
      // Riwayat SOS tetap untuk statistik, tetapi koordinat lokasi dihapus.
      await client.query(
        `UPDATE log_sos SET koordinat_lokasi_enc = NULL, lokasi_izin = false WHERE id_mahasiswa = $1`,
        [idMahasiswa],
      );
      await client.query(
        `UPDATE refresh_token SET revoked_at = COALESCE(revoked_at, now())
         WHERE id_pengguna = $1 AND role = 'MAHASISWA'`,
        [idMahasiswa],
      );
      await client.query(
        `UPDATE mahasiswa
         SET nim = 'DIHAPUS-' || id_mahasiswa::text,
             nama = 'Pengguna Dihapus',
             nama_tampilan = NULL,
             email = 'dihapus+' || id_mahasiswa::text || '@invalid.local',
             sso_subject = NULL,
             status_aktif = false,
             deleted_at = now()
         WHERE id_mahasiswa = $1`,
        [idMahasiswa],
      );
      await this.audit.catat(
        {
          aktor: { id: idMahasiswa, role: 'MAHASISWA' },
          aksi: 'DATA_HAPUS',
          resourceType: 'mahasiswa',
          resourceId: idMahasiswa,
          ip: context.ip,
          userAgent: context.userAgent,
        },
        client,
      );
    });
  }

  private async lockMahasiswa(client: PoolClient, idMahasiswa: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM mahasiswa WHERE id_mahasiswa = $1 AND deleted_at IS NULL FOR UPDATE`,
      [idMahasiswa],
    );
    if (!result.rowCount) {
      throw new NotFoundException({ kode: 'AKUN_TIDAK_DITEMUKAN', pesan: 'Akun tidak ditemukan' });
    }
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

  private encryptPhone(idKontak: string, phone: string): Buffer {
    return this.encryption.encrypt(phone, `kontak_darurat:no_telepon_enc:${idKontak}`);
  }

  private toKontak(row: KontakRow): KontakDarurat {
    return {
      id: row.id,
      nama_kontak: row.nama_kontak,
      no_telepon: this.encryption
        .decrypt(row.no_telepon_enc, `kontak_darurat:no_telepon_enc:${row.id}`)
        .toString('utf8'),
      hubungan: row.hubungan,
      created_at: row.created_at,
    };
  }

  private kontakNotFound(): NotFoundException {
    return new NotFoundException({ kode: 'KONTAK_TIDAK_DITEMUKAN', pesan: 'Kontak darurat tidak ditemukan' });
  }
}
