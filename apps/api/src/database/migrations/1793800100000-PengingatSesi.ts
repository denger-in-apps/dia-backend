import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PBI-14 (SCRUM-253): kolom kerja worker pengingat sesi.
 * - `coba_lagi_at`: jadwal percobaan berikutnya / lease klaim worker (multi-instance);
 * - `inapp_at`: notifikasi in-app sudah dibuat (idempoten, terpisah dari status email);
 * - `error`: pesan kegagalan email terakhir (tanpa alamat email).
 */
export class PengingatSesi1793800100000 implements MigrationInterface {
  name = 'PengingatSesi1793800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pengingat_sesi
        ADD COLUMN coba_lagi_at timestamptz,
        ADD COLUMN inapp_at timestamptz,
        ADD COLUMN error text,
        ADD CONSTRAINT pengingat_sesi_offset_valid CHECK (offset_menit BETWEEN 5 AND 10080);
      CREATE INDEX idx_pengingat_antre ON pengingat_sesi(coba_lagi_at) WHERE status = 'ANTRE';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_pengingat_antre;
      ALTER TABLE pengingat_sesi
        DROP CONSTRAINT IF EXISTS pengingat_sesi_offset_valid,
        DROP COLUMN IF EXISTS error,
        DROP COLUMN IF EXISTS inapp_at,
        DROP COLUMN IF EXISTS coba_lagi_at;
    `);
  }
}
