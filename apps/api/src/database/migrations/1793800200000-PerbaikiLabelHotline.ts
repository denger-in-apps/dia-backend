import { MigrationInterface, QueryRunner } from 'typeorm';

/** Label hotline yang benar (UTF-8, em dash). */
export const HOTLINE_LABEL_BENAR = 'Healing119.id — 119 ext. 8';
/** Hasil UTF-8 yang ter-encode dua kali di `0001_init.sql` ("â€”" alih-alih "—"). */
export const HOTLINE_LABEL_RUSAK = 'Healing119.id â€” 119 ext. 8';

/**
 * SCRUM-236: default `konfigurasi_sos.hotline_label` di `0001_init.sql` tersimpan
 * dengan mojibake sehingga teks rusak terkirim di SMS eskalasi dan tampil ke mahasiswa.
 * Migrasi lama tidak diedit (04-database.md §5); baris yang masih bernilai rusak
 * diperbaiki dan default kolom diganti. Label yang sudah diubah admin tidak disentuh.
 */
export class PerbaikiLabelHotline1793800200000 implements MigrationInterface {
  name = 'PerbaikiLabelHotline1793800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE konfigurasi_sos SET hotline_label = $1 WHERE hotline_label = $2`,
      [HOTLINE_LABEL_BENAR, HOTLINE_LABEL_RUSAK],
    );
    await queryRunner.query(
      `ALTER TABLE konfigurasi_sos ALTER COLUMN hotline_label SET DEFAULT 'Healing119.id — 119 ext. 8'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Tidak mengembalikan teks rusak; cukup kembalikan default kolom seperti 0001.
    await queryRunner.query(
      `ALTER TABLE konfigurasi_sos ALTER COLUMN hotline_label SET DEFAULT 'Healing119.id â€” 119 ext. 8'`,
    );
  }
}
