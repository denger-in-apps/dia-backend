import { MigrationInterface, QueryRunner } from 'typeorm';

/** SCRUM-261: indeks balasan per curhat (detail & hitungan balasan dibaca di setiap daftar). */
export class CurhatBalasan1793900100000 implements MigrationInterface {
  name = 'CurhatBalasan1793900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_curhat_balasan ON curhat_balasan(id_curhat, waktu)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_curhat_balasan`);
  }
}
