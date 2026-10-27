"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitialSchema1761500000000 = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
class InitialSchema1761500000000 {
    constructor() {
        this.name = 'InitialSchema1761500000000';
    }
    async up(queryRunner) {
        const schema = (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../sql/0001_init.sql'), 'utf8');
        await queryRunner.query(schema);
    }
    async down(queryRunner) {
        await queryRunner.query(`
      DROP VIEW IF EXISTS v_laporan_circle, v_laporan_cek_mandiri_bulanan,
        v_laporan_genta_bulanan, v_curhat_untuk_psikolog CASCADE;
      DROP TABLE IF EXISTS pengingat_sesi, notifikasi, sumber_daya,
        circle_pesan, keanggotaan_circle, circle, preferensi_minat,
        kategori_minat, curhat_balasan, curhat_anonim, hasil_cek_mandiri,
        template_kuesioner, sesi_pesan, sesi_konseling, log_eskalasi,
        log_sos, penerima_eskalasi, konfigurasi_sos, jadwal_jaga,
        kontak_darurat, kunci_e2ee, refresh_token, mahasiswa, psikolog,
        dosen_admin, audit_log CASCADE;
      DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
      DROP FUNCTION IF EXISTS audit_log_immutable() CASCADE;
      DROP TYPE IF EXISTS role_pengguna, jenis_notifikasi, status_kirim,
        kanal_eskalasi, tingkat_risiko, kategori_sumber, status_akun_staf,
        status_circle, status_curhat, prioritas_sos, status_sos,
        status_sesi, tipe_sesi CASCADE;
    `);
    }
}
exports.InitialSchema1761500000000 = InitialSchema1761500000000;
//# sourceMappingURL=1761500000000-InitialSchema.js.map