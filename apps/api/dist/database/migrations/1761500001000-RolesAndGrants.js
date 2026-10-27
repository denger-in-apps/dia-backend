"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RolesAndGrants1761500001000 = void 0;
class RolesAndGrants1761500001000 {
    constructor() {
        this.name = 'RolesAndGrants1761500001000';
    }
    async up(queryRunner) {
        const appPassword = process.env.APP_DB_PASSWORD;
        const reportPassword = process.env.REPORT_DB_PASSWORD;
        if (!appPassword || !reportPassword) {
            throw new Error('APP_DB_PASSWORD dan REPORT_DB_PASSWORD wajib diisi untuk migrasi role database');
        }
        const [{ statement: createAppRole }] = await queryRunner.query(`SELECT format('CREATE ROLE denger_app LOGIN PASSWORD %L', $1::text) AS statement`, [appPassword]);
        await queryRunner.query(createAppRole);
        const [{ statement: createReportRole }] = await queryRunner.query(`SELECT format('CREATE ROLE denger_report LOGIN PASSWORD %L', $1::text) AS statement`, [reportPassword]);
        await queryRunner.query(createReportRole);
        await queryRunner.query(`
      GRANT USAGE ON SCHEMA public TO denger_app, denger_report;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO denger_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO denger_app;
      REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM denger_app;
      GRANT SELECT ON v_laporan_genta_bulanan,
        v_laporan_cek_mandiri_bulanan, v_laporan_circle TO denger_report;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO denger_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO denger_app;
    `);
    }
    async down(queryRunner) {
        await queryRunner.query(`
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM denger_report;
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM denger_app;
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM denger_app;
      REVOKE USAGE ON SCHEMA public FROM denger_report, denger_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM denger_report;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM denger_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM denger_app;
      DROP ROLE denger_report;
      DROP ROLE denger_app;
    `);
    }
}
exports.RolesAndGrants1761500001000 = RolesAndGrants1761500001000;
//# sourceMappingURL=1761500001000-RolesAndGrants.js.map