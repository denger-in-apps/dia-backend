import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCRUM-234: notifikasi in-app eskalasi SOS memakai jenis sendiri (`SOS_ESKALASI`), bukan
 * `SOS_BARU` + flag payload, agar klien dapat memfilter/menonjolkannya. Baris lama dimigrasikan.
 */
export class NotifikasiSosEskalasi1793800400000 implements MigrationInterface {
  name = 'NotifikasiSosEskalasi1793800400000';
  // ADD VALUE tidak boleh dipakai di transaksi yang sama dengan nilai barunya (PostgreSQL),
  // sehingga migrasi ini berjalan di luar transaksi global TypeORM.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE jenis_notifikasi ADD VALUE IF NOT EXISTS 'SOS_ESKALASI' AFTER 'SOS_BARU'`);
    await queryRunner.query(
      `UPDATE notifikasi SET jenis = 'SOS_ESKALASI'
       WHERE jenis = 'SOS_BARU' AND (payload->>'eskalasi')::boolean IS TRUE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Nilai enum tidak dapat dihapus; kembalikan baris ke bentuk lama.
    await queryRunner.query(`UPDATE notifikasi SET jenis = 'SOS_BARU' WHERE jenis = 'SOS_ESKALASI'`);
  }
}
