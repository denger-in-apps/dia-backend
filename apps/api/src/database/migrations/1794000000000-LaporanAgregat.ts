import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PBI-20 (SCRUM-274): view laporan agregat tambahan untuk layanan konseling dan curhat,
 * dengan aturan sama seperti view laporan lain — grup berjumlah < 5 dibuang (k-anonimitas
 * sederhana, 02-backend.md §9.5) — dan hanya dapat dibaca role `denger_report`.
 */
export class LaporanAgregat1794000000000 implements MigrationInterface {
  name = 'LaporanAgregat1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE VIEW v_laporan_sesi_bulanan AS
        SELECT date_trunc('month', waktu_mulai) AS bulan, tipe_sesi, status_sesi, count(*) AS jumlah
        FROM sesi_konseling
        GROUP BY 1, 2, 3
        HAVING count(*) >= 5;

      CREATE VIEW v_laporan_curhat_bulanan AS
        SELECT date_trunc('month', waktu_curhat) AS bulan,
               count(*) AS total_curhat,
               count(*) FILTER (WHERE status = 'DIJAWAB') AS total_dijawab
        FROM curhat_anonim
        GROUP BY 1
        HAVING count(*) >= 5;

      GRANT SELECT ON v_laporan_sesi_bulanan, v_laporan_curhat_bulanan TO denger_report;
      -- API (denger_app) tidak perlu membaca laporan; laporan dibaca lewat koneksi denger_report.
      REVOKE ALL ON v_laporan_sesi_bulanan, v_laporan_curhat_bulanan FROM denger_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS v_laporan_curhat_bulanan, v_laporan_sesi_bulanan`);
  }
}
