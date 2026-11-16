import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-263: alias anonim unik per Circle (tidak ada dua anggota beralias sama dalam satu
 * ruang) dan indeks keanggotaan per Circle untuk hitungan kuota.
 */
export class CircleKeanggotaan1793900200000 implements MigrationInterface {
  name = 'CircleKeanggotaan1793900200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE keanggotaan_circle
        ADD CONSTRAINT keanggotaan_circle_alias_unik UNIQUE (id_circle, alias_anonim);
      CREATE INDEX IF NOT EXISTS idx_keanggotaan_circle ON keanggotaan_circle(id_circle);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_keanggotaan_circle;
      ALTER TABLE keanggotaan_circle DROP CONSTRAINT IF EXISTS keanggotaan_circle_alias_unik;
    `);
  }
}
