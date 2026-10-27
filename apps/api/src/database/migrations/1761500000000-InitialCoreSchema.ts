import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema inferred from entities and constraints in 02-backend.md.
 * Extend or replace it once the canonical ERD is added to the repository.
 */
export class InitialCoreSchema1761500000000 implements MigrationInterface {
  name = 'InitialCoreSchema1761500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(`
      CREATE TYPE role_akun AS ENUM ('MAHASISWA', 'PSIKOLOG', 'DOSEN_ADMIN');
      CREATE TYPE status_sos AS ENUM ('MENUNGGU', 'DITANGANI', 'SELESAI', 'DIBATALKAN');
      CREATE TYPE status_sesi AS ENUM ('DIBOOKING', 'BERLANGSUNG', 'SELESAI', 'DIBATALKAN', 'TIDAK_HADIR');
    `);
    await queryRunner.query(`
      CREATE TABLE mahasiswa (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sso_subject varchar(255) NOT NULL UNIQUE,
        nim varchar(32) NOT NULL UNIQUE,
        email varchar(255) NOT NULL,
        nama varchar(200) NOT NULL,
        aktif boolean NOT NULL DEFAULT true,
        akademik_terverifikasi_pada timestamptz,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        diubah_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE psikolog (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255) NOT NULL UNIQUE,
        nama varchar(200) NOT NULL,
        password_hash text NOT NULL,
        status_aktif boolean NOT NULL DEFAULT false,
        status_jaga boolean NOT NULL DEFAULT false,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        diubah_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE dosen_admin (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255) NOT NULL UNIQUE,
        nama varchar(200) NOT NULL,
        password_hash text NOT NULL,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        diubah_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE refresh_token (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        role role_akun NOT NULL,
        id_pengguna uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        id_token_induk uuid REFERENCES refresh_token(id),
        berlaku_sampai timestamptz NOT NULL,
        dicabut_pada timestamptz,
        dibuat_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_refresh_token_pengguna ON refresh_token(role, id_pengguna);
      CREATE TABLE kontak_darurat (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        id_mahasiswa uuid NOT NULL REFERENCES mahasiswa(id) ON DELETE CASCADE,
        nama varchar(200) NOT NULL,
        nomor_telepon varchar(32) NOT NULL,
        hubungan varchar(80),
        dibuat_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE jadwal_jaga (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        id_psikolog uuid NOT NULL REFERENCES psikolog(id),
        waktu_mulai timestamptz NOT NULL,
        waktu_selesai timestamptz NOT NULL,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_jadwal_jaga_waktu CHECK (waktu_selesai > waktu_mulai)
      );
      CREATE INDEX idx_jadwal_jaga_psikolog_waktu ON jadwal_jaga(id_psikolog, waktu_mulai, waktu_selesai);
      CREATE TABLE log_sos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        id_mahasiswa uuid NOT NULL REFERENCES mahasiswa(id),
        id_psikolog uuid REFERENCES psikolog(id),
        situasi text NOT NULL,
        status status_sos NOT NULL DEFAULT 'MENUNGGU',
        prioritas smallint NOT NULL DEFAULT 0 CHECK (prioritas >= 0),
        lokasi_latitude numeric(9,6),
        lokasi_longitude numeric(9,6),
        lokasi_dibagikan_pada timestamptz,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        ditangani_pada timestamptz,
        selesai_pada timestamptz,
        CONSTRAINT ck_log_sos_latitude CHECK (lokasi_latitude IS NULL OR lokasi_latitude BETWEEN -90 AND 90),
        CONSTRAINT ck_log_sos_longitude CHECK (lokasi_longitude IS NULL OR lokasi_longitude BETWEEN -180 AND 180),
        CONSTRAINT ck_log_sos_lokasi_pair CHECK ((lokasi_latitude IS NULL) = (lokasi_longitude IS NULL))
      );
      CREATE INDEX idx_log_sos_antrean ON log_sos(status, prioritas DESC, dibuat_pada);
      CREATE INDEX idx_log_sos_mahasiswa ON log_sos(id_mahasiswa, dibuat_pada DESC);
      CREATE UNIQUE INDEX uq_log_sos_aktif_mahasiswa ON log_sos(id_mahasiswa)
        WHERE status IN ('MENUNGGU', 'DITANGANI');
      CREATE TABLE sesi_konseling (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        id_mahasiswa uuid NOT NULL REFERENCES mahasiswa(id),
        id_psikolog uuid NOT NULL REFERENCES psikolog(id),
        waktu_mulai timestamptz NOT NULL,
        waktu_selesai timestamptz NOT NULL,
        status status_sesi NOT NULL DEFAULT 'DIBOOKING',
        tipe_sesi varchar(30) NOT NULL,
        keluhan_awal text,
        consent_catatan boolean NOT NULL DEFAULT false,
        ringkasan_enkripsi bytea,
        dibuat_pada timestamptz NOT NULL DEFAULT now(),
        diubah_pada timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_sesi_waktu CHECK (waktu_selesai > waktu_mulai)
      );
      ALTER TABLE sesi_konseling ADD CONSTRAINT ex_sesi_psikolog_bentrok
        EXCLUDE USING gist (
          id_psikolog WITH =,
          tstzrange(waktu_mulai, waktu_selesai, '[)') WITH &&
        ) WHERE (status IN ('DIBOOKING', 'BERLANGSUNG'));
      CREATE INDEX idx_sesi_mahasiswa_waktu ON sesi_konseling(id_mahasiswa, waktu_mulai DESC);
      CREATE INDEX idx_sesi_psikolog_waktu ON sesi_konseling(id_psikolog, waktu_mulai);
      CREATE TABLE audit_log (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        role_aktor role_akun NOT NULL,
        id_aktor uuid NOT NULL,
        aksi varchar(100) NOT NULL,
        resource varchar(100) NOT NULL,
        id_resource varchar(100),
        hasil varchar(30) NOT NULL,
        alamat_ip inet,
        dibuat_pada timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_audit_log_waktu ON audit_log(dibuat_pada DESC);
      CREATE INDEX idx_audit_log_aktor_aksi ON audit_log(id_aktor, aksi, dibuat_pada DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS audit_log, sesi_konseling, log_sos, jadwal_jaga,
        kontak_darurat, refresh_token, dosen_admin, psikolog, mahasiswa CASCADE;
      DROP TYPE IF EXISTS status_sesi;
      DROP TYPE IF EXISTS status_sos;
      DROP TYPE IF EXISTS role_akun;
    `);
  }
}
