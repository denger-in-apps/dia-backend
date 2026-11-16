import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PBI-20 (SCRUM-275): paling banyak satu template aktif per kuesioner (PHQ9/GAD7), sehingga
 * cek mandiri selalu memakai versi yang jelas saat admin mengaktifkan versi baru.
 */
export class TemplateKuesionerAktifTunggal1794000100000 implements MigrationInterface {
  name = 'TemplateKuesionerAktifTunggal1794000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Bila data lama punya >1 template aktif per kode, sisakan versi tertinggi.
    await queryRunner.query(`
      UPDATE template_kuesioner t SET aktif = false
      WHERE t.aktif AND EXISTS (
        SELECT 1 FROM template_kuesioner l WHERE l.kode = t.kode AND l.aktif AND l.versi > t.versi
      );
      CREATE UNIQUE INDEX uq_template_kuesioner_aktif ON template_kuesioner(kode) WHERE aktif;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_template_kuesioner_aktif`);
  }
}
