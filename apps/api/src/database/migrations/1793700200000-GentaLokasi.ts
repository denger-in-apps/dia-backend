import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-226 (PBI-06, FR-MHS-04) — berbagi lokasi darurat.
 * Koordinat tetap di `koordinat_lokasi_enc` (AES-256-GCM, AAD per baris) dan hanya
 * boleh terisi bila `lokasi_izin` (constraint `log_sos_lokasi_konsisten` dari skema awal).
 */
export class GentaLokasi1793700200000 implements MigrationInterface {
  name = 'GentaLokasi1793700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE log_sos ADD COLUMN lokasi_diperbarui_at timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE log_sos DROP COLUMN IF EXISTS lokasi_diperbarui_at`);
  }
}
