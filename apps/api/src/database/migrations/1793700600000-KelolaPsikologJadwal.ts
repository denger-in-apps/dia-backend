import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-237 (PBI-09, FR-ADM-02) — kelola akun psikolog & jadwal jaga.
 * - `wajib_ganti_password`: akun baru / hasil reset memakai password sementara.
 * - Exclusion constraint: jadwal jaga seorang psikolog tidak boleh tumpang tindih
 *   (melengkapi UNIQUE (id_psikolog, tanggal, jam_mulai) dari skema awal).
 *   `tanggal + jam` (date + time → timestamp) bersifat IMMUTABLE sehingga dapat diindeks.
 */
export class KelolaPsikologJadwal1793700600000 implements MigrationInterface {
  name = 'KelolaPsikologJadwal1793700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE psikolog ADD COLUMN wajib_ganti_password boolean NOT NULL DEFAULT false;
      ALTER TABLE dosen_admin ADD COLUMN wajib_ganti_password boolean NOT NULL DEFAULT false;
      ALTER TABLE jadwal_jaga ADD CONSTRAINT jadwal_jaga_tidak_bentrok EXCLUDE USING gist (
        id_psikolog WITH =,
        tsrange(tanggal + jam_mulai, tanggal + jam_selesai) WITH &&
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE jadwal_jaga DROP CONSTRAINT IF EXISTS jadwal_jaga_tidak_bentrok;
      ALTER TABLE dosen_admin DROP COLUMN IF EXISTS wajib_ganti_password;
      ALTER TABLE psikolog DROP COLUMN IF EXISTS wajib_ganti_password;
    `);
  }
}
