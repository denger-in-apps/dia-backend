import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PBI-10 (SCRUM-242): jenis notifikasi `SESI_BARU` untuk psikolog saat dibooking.
 * Anti-bentrok sesi sudah dijamin exclusion constraint `sesi_tidak_bentrok_*` di 0001.
 */
export class BookingKonseling1793800000000 implements MigrationInterface {
  name = 'BookingKonseling1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL ≥ 12 mengizinkan ADD VALUE di dalam transaksi selama nilainya tidak dipakai di transaksi yang sama.
    await queryRunner.query(`ALTER TYPE jenis_notifikasi ADD VALUE IF NOT EXISTS 'SESI_BARU' AFTER 'PENGINGAT_SESI'`);
  }

  public async down(): Promise<void> {
    // PostgreSQL tidak mendukung penghapusan nilai enum; nilai `SESI_BARU` dibiarkan (tidak berbahaya).
  }
}
