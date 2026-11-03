import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-213 (PBI-03, FR-MHS-12) — pengelolaan data milik mahasiswa.
 *
 * `nama`, `nim`, dan `email` bersumber dari SSO kampus dan ditimpa saat login,
 * sehingga data profil yang dapat diubah mahasiswa disimpan di kolom terpisah
 * `nama_tampilan`. Anonimisasi akun (DELETE /me) mengosongkan kolom ini.
 */
export class AkunMahasiswa1793700000000 implements MigrationInterface {
  name = 'AkunMahasiswa1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mahasiswa ADD COLUMN nama_tampilan text;
      ALTER TABLE mahasiswa ADD CONSTRAINT mahasiswa_nama_tampilan_panjang
        CHECK (nama_tampilan IS NULL OR char_length(nama_tampilan) BETWEEN 1 AND 60);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mahasiswa DROP CONSTRAINT IF EXISTS mahasiswa_nama_tampilan_panjang;
      ALTER TABLE mahasiswa DROP COLUMN IF EXISTS nama_tampilan;
    `);
  }
}
