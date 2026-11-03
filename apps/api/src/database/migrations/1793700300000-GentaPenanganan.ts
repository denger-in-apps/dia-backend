import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-232 (PBI-08, FR-PSI-02) — dashboard penanganan SOS psikolog.
 * Catatan penanganan disimpan terenkripsi (AAD `log_sos:catatan_penanganan_enc:<id_sos>`).
 */
export class GentaPenanganan1793700300000 implements MigrationInterface {
  name = 'GentaPenanganan1793700300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_sos ADD COLUMN waktu_ditangani timestamptz;
      ALTER TABLE log_sos ADD COLUMN catatan_penanganan_enc bytea;
      CREATE INDEX idx_log_sos_psikolog ON log_sos(id_psikolog, status_penanganan)
        WHERE id_psikolog IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_log_sos_psikolog;
      ALTER TABLE log_sos DROP COLUMN IF EXISTS catatan_penanganan_enc;
      ALTER TABLE log_sos DROP COLUMN IF EXISTS waktu_ditangani;
    `);
  }
}
