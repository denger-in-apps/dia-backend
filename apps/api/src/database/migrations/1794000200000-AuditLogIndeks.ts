import { MigrationInterface, QueryRunner } from 'typeorm';

/** PBI-21 (SCRUM-277): indeks filter audit log per aksi dan per hasil (mis. DITOLAK) terbaru. */
export class AuditLogIndeks1794000200000 implements MigrationInterface {
  name = 'AuditLogIndeks1794000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_aksi ON audit_log(aksi, id_log DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_ditolak ON audit_log(id_log DESC) WHERE hasil = 'DITOLAK';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_ditolak; DROP INDEX IF EXISTS idx_audit_aksi;`);
  }
}
