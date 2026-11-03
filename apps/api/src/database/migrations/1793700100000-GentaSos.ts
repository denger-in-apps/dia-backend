import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-223 (PBI-05, FR-MHS-03) — tombol darurat Genta.
 *
 * - `situasi` dibatasi ke kode pilihan konfirmasi singkat.
 * - `perlu_verifikasi` menandai SOS dari akun dengan riwayat laporan tidak valid
 *   atau pembatalan berulang (SOS tetap diterima, tidak pernah ditolak).
 * - `ditandai_iseng` / `alasan_selesai` mencatat hasil akhir kasus; dipakai
 *   menghitung riwayat penyalahgunaan.
 * - Indeks unik parsial menjamin satu SOS aktif per mahasiswa (dedupe di DB).
 */
export class GentaSos1793700100000 implements MigrationInterface {
  name = 'GentaSos1793700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_sos ADD COLUMN perlu_verifikasi boolean NOT NULL DEFAULT false;
      ALTER TABLE log_sos ADD COLUMN ditandai_iseng boolean NOT NULL DEFAULT false;
      ALTER TABLE log_sos ADD COLUMN alasan_selesai text;
      ALTER TABLE log_sos ADD CONSTRAINT log_sos_alasan_selesai_valid CHECK (
        alasan_selesai IS NULL
        OR alasan_selesai IN ('DITANGANI', 'DIBATALKAN_MAHASISWA', 'LAPORAN_TIDAK_VALID')
      );
      ALTER TABLE log_sos ADD CONSTRAINT log_sos_situasi_valid CHECK (
        situasi IS NULL OR situasi IN (
          'INGIN_MENYAKITI_DIRI', 'DALAM_BAHAYA', 'SERANGAN_PANIK', 'BUTUH_PENDAMPINGAN', 'LAINNYA'
        )
      );
      CREATE UNIQUE INDEX uq_log_sos_aktif_per_mahasiswa ON log_sos(id_mahasiswa)
        WHERE status_penanganan IN ('BARU', 'DIAMBIL', 'DITANGANI', 'ESKALASI');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_log_sos_aktif_per_mahasiswa;
      ALTER TABLE log_sos DROP CONSTRAINT IF EXISTS log_sos_situasi_valid;
      ALTER TABLE log_sos DROP CONSTRAINT IF EXISTS log_sos_alasan_selesai_valid;
      ALTER TABLE log_sos DROP COLUMN IF EXISTS alasan_selesai;
      ALTER TABLE log_sos DROP COLUMN IF EXISTS ditandai_iseng;
      ALTER TABLE log_sos DROP COLUMN IF EXISTS perlu_verifikasi;
    `);
  }
}
