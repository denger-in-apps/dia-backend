import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-236 (PBI-09, FR-ADM-05) — konfigurasi eskalasi oleh Dosen Admin.
 * Kebijakan kontak darurat (SCRUM-235) dan ambang anti-penyalahgunaan tombol Genta
 * (PBI-05, sebelumnya env) dipindah ke `konfigurasi_sos` agar dapat diubah saat runtime.
 * Batas bawah CHECK mencegah konfigurasi yang mematikan tombol SOS (mis. 0 SOS/jam).
 */
export class KonfigurasiEskalasi1793700500000 implements MigrationInterface {
  name = 'KonfigurasiEskalasi1793700500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE konfigurasi_sos
        ADD COLUMN kontak_darurat_aktif boolean NOT NULL DEFAULT true,
        ADD COLUMN kontak_darurat_untuk_perlu_verifikasi boolean NOT NULL DEFAULT false,
        ADD COLUMN maks_eskalasi_kontak_per_hari smallint NOT NULL DEFAULT 3
          CHECK (maks_eskalasi_kontak_per_hari BETWEEN 1 AND 10),
        ADD COLUMN sos_maks_per_jam smallint NOT NULL DEFAULT 5
          CHECK (sos_maks_per_jam BETWEEN 1 AND 60),
        ADD COLUMN sos_ambang_iseng_30_hari smallint NOT NULL DEFAULT 2
          CHECK (sos_ambang_iseng_30_hari BETWEEN 1 AND 100),
        ADD COLUMN sos_ambang_batal_24_jam smallint NOT NULL DEFAULT 3
          CHECK (sos_ambang_batal_24_jam BETWEEN 1 AND 100);
      CREATE TRIGGER trg_upd_konfigurasi_sos BEFORE UPDATE ON konfigurasi_sos
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_upd_konfigurasi_sos ON konfigurasi_sos;
      ALTER TABLE konfigurasi_sos
        DROP COLUMN IF EXISTS sos_ambang_batal_24_jam,
        DROP COLUMN IF EXISTS sos_ambang_iseng_30_hari,
        DROP COLUMN IF EXISTS sos_maks_per_jam,
        DROP COLUMN IF EXISTS maks_eskalasi_kontak_per_hari,
        DROP COLUMN IF EXISTS kontak_darurat_untuk_perlu_verifikasi,
        DROP COLUMN IF EXISTS kontak_darurat_aktif;
    `);
  }
}
