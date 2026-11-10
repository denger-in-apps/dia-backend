import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-235 (PBI-09) — integrasi SMS gateway eskalasi.
 * `jenis_penerima` membedakan penerima eskalasi kampus, kontak darurat mahasiswa,
 * dan info hotline; dipakai untuk membatasi SMS ke kontak darurat per mahasiswa.
 */
export class EskalasiSms1793700400000 implements MigrationInterface {
  name = 'EskalasiSms1793700400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_eskalasi ADD COLUMN jenis_penerima text NOT NULL DEFAULT 'PENERIMA_ESKALASI';
      ALTER TABLE log_eskalasi ADD CONSTRAINT log_eskalasi_jenis_penerima_valid
        CHECK (jenis_penerima IN ('PENERIMA_ESKALASI', 'KONTAK_DARURAT', 'HOTLINE'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE log_eskalasi DROP CONSTRAINT IF EXISTS log_eskalasi_jenis_penerima_valid;
      ALTER TABLE log_eskalasi DROP COLUMN IF EXISTS jenis_penerima;
    `);
  }
}
