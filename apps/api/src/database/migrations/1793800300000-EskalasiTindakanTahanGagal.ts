import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-235: tindakan eskalasi (SMS + info hotline) tahan crash/DB down.
 *
 * Sebelumnya status `ESKALASI` di-commit lebih dulu lalu SMS dikirim; bila proses mati
 * di antaranya, SMS hilang selamanya (retry job & sweeper hanya melihat status `BARU`).
 * Kolom outbox ini membuat sweeper dapat mengklaim ulang tindakan yang belum selesai.
 */
export class EskalasiTindakanTahanGagal1793800300000 implements MigrationInterface {
  name = 'EskalasiTindakanTahanGagal1793800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_sos
        ADD COLUMN tindakan_eskalasi_at timestamptz,
        ADD COLUMN tindakan_klaim_at timestamptz,
        ADD COLUMN tindakan_percobaan smallint NOT NULL DEFAULT 0;
      -- Eskalasi lama dianggap sudah ditindak agar tidak memicu SMS susulan setelah deploy.
      UPDATE log_sos SET tindakan_eskalasi_at = waktu_eskalasi WHERE waktu_eskalasi IS NOT NULL;
      CREATE INDEX idx_log_sos_tindakan_tertunda ON log_sos(tindakan_klaim_at)
        WHERE status_penanganan = 'ESKALASI' AND tindakan_eskalasi_at IS NULL;
      -- Rujukan penerima (jenis:id) agar retry tidak mengirim ulang SMS yang sudah terkirim.
      ALTER TABLE log_eskalasi ADD COLUMN penerima_ref text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_eskalasi DROP COLUMN IF EXISTS penerima_ref;
      DROP INDEX IF EXISTS idx_log_sos_tindakan_tertunda;
      ALTER TABLE log_sos
        DROP COLUMN IF EXISTS tindakan_percobaan,
        DROP COLUMN IF EXISTS tindakan_klaim_at,
        DROP COLUMN IF EXISTS tindakan_eskalasi_at;
    `);
  }
}
