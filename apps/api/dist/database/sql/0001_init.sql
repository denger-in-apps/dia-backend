-- =====================================================================
-- Denger.in â€” Skema PostgreSQL (v0.1)
-- Sumber: ERD proposal (Bab 4.3) + tabel tambahan untuk memenuhi FR/NFR
-- Konvensi: snake_case, PK uuid, waktu timestamptz (UTC), soft delete
-- Kolom berakhiran _enc = terenkripsi di level aplikasi (AES-256-GCM)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- untuk exclusion constraint anti-bentrok jadwal

-- ---------- ENUM ----------
CREATE TYPE tipe_sesi        AS ENUM ('CHAT', 'SUARA', 'TATAP_MUKA');
CREATE TYPE status_sesi      AS ENUM ('DIJADWALKAN', 'BERLANGSUNG', 'SELESAI', 'DIBATALKAN', 'TIDAK_HADIR');
CREATE TYPE status_sos       AS ENUM ('BARU', 'DIAMBIL', 'DITANGANI', 'ESKALASI', 'SELESAI');
CREATE TYPE prioritas_sos    AS ENUM ('RENDAH', 'SEDANG', 'TINGGI', 'KRITIS');
CREATE TYPE status_curhat    AS ENUM ('BARU', 'DIBACA', 'DIJAWAB');
CREATE TYPE status_circle    AS ENUM ('DIAJUKAN', 'AKTIF', 'DITOLAK', 'DITUTUP');
CREATE TYPE status_akun_staf AS ENUM ('MENUNGGU_VERIFIKASI', 'AKTIF', 'NONAKTIF');
CREATE TYPE kategori_sumber  AS ENUM ('UNIT_KESEHATAN_KAMPUS', 'RUMAH_SAKIT_RUJUKAN', 'HOTLINE_NASIONAL', 'KOMUNITAS_SEBAYA');
CREATE TYPE tingkat_risiko   AS ENUM ('MINIMAL', 'RINGAN', 'SEDANG', 'SEDANG_BERAT', 'BERAT');
CREATE TYPE kanal_eskalasi   AS ENUM ('SMS', 'INFO_HOTLINE');
CREATE TYPE status_kirim     AS ENUM ('ANTRE', 'TERKIRIM', 'GAGAL');
CREATE TYPE jenis_notifikasi AS ENUM ('PENGINGAT_SESI', 'SESI_DIUBAH', 'SESI_DIBATALKAN', 'CURHAT_DIJAWAB', 'CIRCLE_DISETUJUI', 'CIRCLE_DITOLAK', 'SOS_BARU', 'SISTEM');
CREATE TYPE role_pengguna    AS ENUM ('MAHASISWA', 'PSIKOLOG', 'DOSEN_ADMIN');

-- ---------- AKUN ----------
CREATE TABLE dosen_admin (
  id_dosen       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  np             text NOT NULL UNIQUE,                 -- nomor pegawai
  nama           text NOT NULL,
  prodi          text,
  email          citext NOT NULL UNIQUE,
  password_hash  text,                                 -- argon2id (login staf)
  mfa_secret_enc bytea,
  aktif          boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE psikolog (
  id_psikolog       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama              text NOT NULL,
  email             citext NOT NULL UNIQUE,
  status_jaga       boolean NOT NULL DEFAULT false,     -- sedang bertugas SOS (di-sinkron dari jadwal_jaga)
  status_akun       status_akun_staf NOT NULL DEFAULT 'MENUNGGU_VERIFIKASI',
  password_hash     text,
  mfa_secret_enc    bytea,
  diverifikasi_oleh uuid REFERENCES dosen_admin(id_dosen),
  diverifikasi_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mahasiswa (
  id_mahasiswa           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nim                    text NOT NULL UNIQUE,
  nama                   text NOT NULL,
  email                  citext NOT NULL UNIQUE,
  status_aktif           boolean NOT NULL DEFAULT false, -- hasil verifikasi ke sistem akademik
  sso_subject            text UNIQUE,                    -- sub/NameID dari IdP kampus
  terakhir_verifikasi_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz                     -- FR-MHS-12 (soft delete -> anonimisasi)
);

CREATE TABLE refresh_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_pengguna  uuid NOT NULL,
  role         role_pengguna NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text
);
CREATE INDEX idx_refresh_token_pengguna ON refresh_token(id_pengguna);

CREATE TABLE kunci_e2ee (                              -- kunci PUBLIK untuk chat konseling E2EE
  id_pengguna  uuid NOT NULL,
  role         role_pengguna NOT NULL,
  kunci_publik bytea NOT NULL,
  dibuat_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id_pengguna, role)
);

CREATE TABLE kontak_darurat (
  id_kontak      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_kontak    text NOT NULL,
  no_telepon_enc bytea NOT NULL,
  hubungan       text,
  id_mahasiswa   uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kontak_darurat_mhs ON kontak_darurat(id_mahasiswa);

-- ---------- JADWAL JAGA & KONFIGURASI SOS ----------
CREATE TABLE jadwal_jaga (
  id_jadwal    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tanggal      date NOT NULL,
  jam_mulai    time NOT NULL,
  jam_selesai  time NOT NULL,
  id_psikolog  uuid NOT NULL REFERENCES psikolog(id_psikolog),
  id_dosen     uuid NOT NULL REFERENCES dosen_admin(id_dosen),   -- admin yang menetapkan
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jadwal_jaga_jam_valid CHECK (jam_selesai > jam_mulai),
  CONSTRAINT jadwal_jaga_unik UNIQUE (id_psikolog, tanggal, jam_mulai)
);
CREATE INDEX idx_jadwal_jaga_tanggal ON jadwal_jaga(tanggal, jam_mulai);

CREATE TABLE konfigurasi_sos (                         -- FR-ADM-05, satu baris (singleton)
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  durasi_eskalasi_detik   integer NOT NULL DEFAULT 180 CHECK (durasi_eskalasi_detik BETWEEN 30 AND 1800),
  eskalasi_segera_jika_tidak_ada_psikolog boolean NOT NULL DEFAULT true,
  hotline_label           text NOT NULL DEFAULT 'Healing119.id â€” 119 ext. 8',
  hotline_aktif           boolean NOT NULL DEFAULT true,
  diubah_oleh             uuid REFERENCES dosen_admin(id_dosen),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO konfigurasi_sos (id) VALUES (1);

CREATE TABLE penerima_eskalasi (                       -- daftar penerima notifikasi eskalasi (FR-ADM-05)
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama           text NOT NULL,
  no_telepon_enc bytea NOT NULL,
  aktif          boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- GENTA (SOS) ----------
CREATE TABLE log_sos (
  id_sos             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waktu_kejadian     timestamptz NOT NULL DEFAULT now(),
  lokasi_izin        boolean NOT NULL DEFAULT false,
  koordinat_lokasi_enc bytea,                          -- NULL jika tidak diizinkan
  situasi            text,                             -- jawaban konfirmasi singkat (FR-MHS-03)
  prioritas          prioritas_sos NOT NULL DEFAULT 'TINGGI',
  status_penanganan  status_sos NOT NULL DEFAULT 'BARU',
  eskalasi_119       boolean NOT NULL DEFAULT false,
  waktu_eskalasi     timestamptz,
  waktu_diambil      timestamptz,
  waktu_selesai      timestamptz,
  id_mahasiswa       uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa),
  id_psikolog        uuid REFERENCES psikolog(id_psikolog),   -- opsional: terisi saat kasus diambil
  CONSTRAINT log_sos_lokasi_konsisten CHECK (lokasi_izin OR koordinat_lokasi_enc IS NULL)
);
CREATE INDEX idx_log_sos_antrean ON log_sos(status_penanganan, prioritas DESC, waktu_kejadian)
  WHERE status_penanganan IN ('BARU', 'ESKALASI', 'DIAMBIL', 'DITANGANI');
CREATE INDEX idx_log_sos_mhs ON log_sos(id_mahasiswa, waktu_kejadian DESC);

CREATE TABLE log_eskalasi (
  id_eskalasi         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sos              uuid NOT NULL REFERENCES log_sos(id_sos),
  kanal               kanal_eskalasi NOT NULL,
  penerima_masked     text NOT NULL,                   -- mis. 0812****789 (jangan simpan nomor utuh di log)
  status              status_kirim NOT NULL DEFAULT 'ANTRE',
  provider_message_id text,
  percobaan_ke        smallint NOT NULL DEFAULT 1,
  error               text,
  waktu_kirim         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_log_eskalasi_sos ON log_eskalasi(id_sos);

-- ---------- BOOKING & SESI KONSELING ----------
CREATE TABLE sesi_konseling (
  id_sesi              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waktu_mulai          timestamptz NOT NULL,           -- "jadwal" pada ERD
  waktu_selesai        timestamptz NOT NULL,
  tipe_sesi            tipe_sesi NOT NULL,
  status_sesi          status_sesi NOT NULL DEFAULT 'DIJADWALKAN',
  keluhan_awal_enc     bytea,
  consent_catatan      boolean NOT NULL DEFAULT false, -- FR-PSI-05 / NFR-04
  consent_at           timestamptz,
  catatan_ringkasan_enc bytea,
  alasan_batal         text,
  id_mahasiswa         uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa),
  id_psikolog          uuid NOT NULL REFERENCES psikolog(id_psikolog),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sesi_waktu_valid CHECK (waktu_selesai > waktu_mulai),
  CONSTRAINT sesi_ringkasan_butuh_consent CHECK (catatan_ringkasan_enc IS NULL OR consent_catatan),
  -- validasi bentrok jadwal di level DB (FR-MHS-05): psikolog & mahasiswa tidak boleh double-booking
  CONSTRAINT sesi_tidak_bentrok_psikolog EXCLUDE USING gist (
    id_psikolog WITH =, tstzrange(waktu_mulai, waktu_selesai) WITH &&
  ) WHERE (status_sesi IN ('DIJADWALKAN', 'BERLANGSUNG')),
  CONSTRAINT sesi_tidak_bentrok_mahasiswa EXCLUDE USING gist (
    id_mahasiswa WITH =, tstzrange(waktu_mulai, waktu_selesai) WITH &&
  ) WHERE (status_sesi IN ('DIJADWALKAN', 'BERLANGSUNG'))
);
CREATE INDEX idx_sesi_psikolog ON sesi_konseling(id_psikolog, waktu_mulai);
CREATE INDEX idx_sesi_mhs ON sesi_konseling(id_mahasiswa, waktu_mulai DESC);
CREATE INDEX idx_sesi_pengingat ON sesi_konseling(waktu_mulai) WHERE status_sesi = 'DIJADWALKAN';

CREATE TABLE sesi_pesan (                              -- hanya ciphertext (E2EE, NFR-02)
  id_pesan     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sesi      uuid NOT NULL REFERENCES sesi_konseling(id_sesi) ON DELETE CASCADE,
  pengirim     role_pengguna NOT NULL CHECK (pengirim IN ('MAHASISWA', 'PSIKOLOG')),
  ciphertext   bytea NOT NULL,
  nonce        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sesi_pesan ON sesi_pesan(id_sesi, created_at);

-- ---------- CEK MANDIRI ----------
CREATE TABLE template_kuesioner (                      -- FR-ADM-07
  id_template  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kode         text NOT NULL CHECK (kode IN ('PHQ9', 'GAD7')),
  nama         text NOT NULL,
  versi        integer NOT NULL DEFAULT 1,
  butir        jsonb NOT NULL,                         -- daftar pertanyaan + opsi + skor
  aktif        boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES dosen_admin(id_dosen),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kode, versi)
);

CREATE TABLE hasil_cek_mandiri (
  id_cek          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waktu_tes       timestamptz NOT NULL DEFAULT now(),
  skor_phq9       smallint CHECK (skor_phq9 BETWEEN 0 AND 27),
  skor_gad7       smallint CHECK (skor_gad7 BETWEEN 0 AND 21),
  risiko_phq9     tingkat_risiko,
  risiko_gad7     tingkat_risiko,
  butir9_positif  boolean NOT NULL DEFAULT false,      -- PHQ-9 butir 9 > 0 -> tampilkan jalur bantuan segera
  jawaban_enc     bytea,
  rekomendasi     text,
  id_template_phq9 uuid REFERENCES template_kuesioner(id_template),
  id_template_gad7 uuid REFERENCES template_kuesioner(id_template),
  id_mahasiswa    uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa) ON DELETE CASCADE
);
CREATE INDEX idx_cek_mhs ON hasil_cek_mandiri(id_mahasiswa, waktu_tes DESC);

-- ---------- CURHAT ANONIM ----------
CREATE TABLE curhat_anonim (
  id_curhat     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waktu_curhat  timestamptz NOT NULL DEFAULT now(),
  isi_curhat_enc bytea NOT NULL,
  status        status_curhat NOT NULL DEFAULT 'BARU',
  alias_anonim  text NOT NULL,                         -- yang terlihat oleh psikolog, mis. "Anonim-7F3A"
  id_mahasiswa  uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa) ON DELETE CASCADE
);
CREATE INDEX idx_curhat_status ON curhat_anonim(status, waktu_curhat);
CREATE INDEX idx_curhat_mhs ON curhat_anonim(id_mahasiswa);

CREATE TABLE curhat_balasan (
  id_balasan   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_curhat    uuid NOT NULL REFERENCES curhat_anonim(id_curhat) ON DELETE CASCADE,
  id_psikolog  uuid NOT NULL REFERENCES psikolog(id_psikolog),
  isi_enc      bytea NOT NULL,
  waktu        timestamptz NOT NULL DEFAULT now()
);

-- View untuk API psikolog: TIDAK memuat id_mahasiswa (anonimitas, FR-MHS-09)
CREATE VIEW v_curhat_untuk_psikolog AS
  SELECT id_curhat, waktu_curhat, isi_curhat_enc, status, alias_anonim
  FROM curhat_anonim;

-- ---------- CIRCLE ----------
CREATE TABLE kategori_minat (                          -- master data FR-ADM-07
  id_kategori  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama         text NOT NULL UNIQUE,
  aktif        boolean NOT NULL DEFAULT true
);

CREATE TABLE preferensi_minat (                        -- input rekomendasi FR-MHS-07
  id_mahasiswa uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa) ON DELETE CASCADE,
  id_kategori  uuid NOT NULL REFERENCES kategori_minat(id_kategori),
  PRIMARY KEY (id_mahasiswa, id_kategori)
);

CREATE TABLE circle (
  id_circle        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_circle      text NOT NULL,
  deskripsi        text,
  id_kategori      uuid NOT NULL REFERENCES kategori_minat(id_kategori),  -- "kategori_minat" pada ERD
  kuota            smallint NOT NULL DEFAULT 8 CHECK (kuota BETWEEN 5 AND 8),
  status           status_circle NOT NULL DEFAULT 'DIAJUKAN',
  id_psikolog      uuid REFERENCES psikolog(id_psikolog),                -- pendamping
  id_dosen         uuid REFERENCES dosen_admin(id_dosen),                -- verifikator
  diajukan_oleh    uuid REFERENCES mahasiswa(id_mahasiswa),
  alasan_penolakan text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT circle_aktif_butuh_pendamping CHECK (status <> 'AKTIF' OR (id_psikolog IS NOT NULL AND id_dosen IS NOT NULL))
);
CREATE INDEX idx_circle_status ON circle(status, id_kategori);

CREATE TABLE keanggotaan_circle (
  id_mahasiswa  uuid NOT NULL REFERENCES mahasiswa(id_mahasiswa) ON DELETE CASCADE,
  id_circle     uuid NOT NULL REFERENCES circle(id_circle) ON DELETE CASCADE,
  status_anonim boolean NOT NULL DEFAULT true,         -- anonim default (NFR-04)
  alias_anonim  text NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id_mahasiswa, id_circle)
);
CREATE INDEX idx_keanggotaan_circle ON keanggotaan_circle(id_circle);

CREATE TABLE circle_pesan (                            -- ASUMSI: ruang interaksi Circle (lihat catatan di dokumen)
  id_pesan     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_circle    uuid NOT NULL REFERENCES circle(id_circle) ON DELETE CASCADE,
  id_mahasiswa uuid,                                   -- salah satu dari id_mahasiswa / id_psikolog terisi
  id_psikolog  uuid REFERENCES psikolog(id_psikolog),
  isi          text NOT NULL,
  disembunyikan boolean NOT NULL DEFAULT false,        -- moderasi (FR-PSI-06)
  alasan_moderasi text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (id_mahasiswa, id_circle) REFERENCES keanggotaan_circle(id_mahasiswa, id_circle) ON DELETE CASCADE,
  CONSTRAINT circle_pesan_satu_pengirim CHECK ((id_mahasiswa IS NULL) <> (id_psikolog IS NULL))
);
CREATE INDEX idx_circle_pesan ON circle_pesan(id_circle, created_at);

-- ---------- DIREKTORI SUMBER DAYA ----------
CREATE TABLE sumber_daya (
  id_sumber   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama        text NOT NULL,
  kategori    kategori_sumber NOT NULL,
  kontak      text NOT NULL,
  deskripsi   text,
  aktif       boolean NOT NULL DEFAULT true,
  id_dosen    uuid NOT NULL REFERENCES dosen_admin(id_dosen),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sumber_kategori ON sumber_daya(kategori) WHERE aktif;

-- ---------- NOTIFIKASI ----------
CREATE TABLE notifikasi (
  id_notifikasi uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_penerima   uuid NOT NULL,
  role          role_pengguna NOT NULL,
  jenis         jenis_notifikasi NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  dibaca_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifikasi_penerima ON notifikasi(id_penerima, created_at DESC);

-- Mencegah pengingat ganda (idempotensi scheduler PBI-14)
CREATE TABLE pengingat_sesi (
  id_sesi      uuid NOT NULL REFERENCES sesi_konseling(id_sesi) ON DELETE CASCADE,
  offset_menit integer NOT NULL,                       -- mis. 1440 (H-1), 60 (H-1 jam)
  status       status_kirim NOT NULL DEFAULT 'ANTRE',
  percobaan    smallint NOT NULL DEFAULT 0,
  dikirim_at   timestamptz,
  PRIMARY KEY (id_sesi, offset_menit)
);

-- ---------- AUDIT LOG (FR-ADM-06 / NFR-08) ----------
CREATE TABLE audit_log (
  id_log        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  waktu         timestamptz NOT NULL DEFAULT now(),
  aktor_id      uuid,
  aktor_role    role_pengguna,
  aksi          text NOT NULL,                         -- mis. SESI_RINGKASAN_READ, SOS_LOKASI_READ
  resource_type text NOT NULL,
  resource_id   text,
  hasil         text NOT NULL DEFAULT 'SUKSES',        -- SUKSES | DITOLAK
  ip            inet,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_waktu ON audit_log(waktu DESC);
CREATE INDEX idx_audit_aktor ON audit_log(aktor_id, waktu DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);

-- Audit log append-only: blok UPDATE/DELETE/TRUNCATE
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log bersifat append-only';
END $$;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ---------- updated_at otomatis ----------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_upd_mahasiswa BEFORE UPDATE ON mahasiswa      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_psikolog  BEFORE UPDATE ON psikolog       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_dosen     BEFORE UPDATE ON dosen_admin    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_sesi      BEFORE UPDATE ON sesi_konseling FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_circle    BEFORE UPDATE ON circle         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_sumber    BEFORE UPDATE ON sumber_daya    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- LAPORAN AGREGAT ANONIM (FR-ADM-04) ----------
-- Hanya mengeluarkan angka agregat; sel dengan jumlah < 5 disembunyikan (k-anonymity sederhana)
CREATE VIEW v_laporan_genta_bulanan AS
  SELECT date_trunc('month', waktu_kejadian) AS bulan,
         count(*)                                        AS total_sos,
         count(*) FILTER (WHERE status_penanganan = 'ESKALASI' OR eskalasi_119) AS total_eskalasi
  FROM log_sos
  GROUP BY 1
  HAVING count(*) >= 5;

CREATE VIEW v_laporan_cek_mandiri_bulanan AS
  SELECT date_trunc('month', waktu_tes) AS bulan,
         risiko_phq9, risiko_gad7,
         count(*) AS jumlah
  FROM hasil_cek_mandiri
  GROUP BY 1, 2, 3
  HAVING count(*) >= 5;

CREATE VIEW v_laporan_circle AS
  SELECT c.id_circle, c.nama_circle, k.nama AS kategori, c.status,
         count(a.id_mahasiswa) AS jumlah_anggota
  FROM circle c
  JOIN kategori_minat k ON k.id_kategori = c.id_kategori
  LEFT JOIN keanggotaan_circle a ON a.id_circle = c.id_circle
  GROUP BY c.id_circle, c.nama_circle, k.nama, c.status;

-- ---------- ROLE DATABASE (least privilege) ----------
-- Jalankan sebagai superuser/owner pada migrasi infrastruktur:
-- CREATE ROLE denger_app LOGIN PASSWORD '...';          -- dipakai API (read/write)
-- CREATE ROLE denger_report LOGIN PASSWORD '...';       -- hanya SELECT pada v_laporan_*
-- GRANT SELECT ON v_laporan_genta_bulanan, v_laporan_cek_mandiri_bulanan, v_laporan_circle TO denger_report;
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM denger_app;