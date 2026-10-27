# DIA API (NestJS Modular Monolith)

Setup sesuai dokumen dia-backend/02-backend.md.

## Docker Compose (development)

1. Salin `.env.example` di root repo ke `.env`, lalu sesuaikan origin FE di
   `CORS_ORIGINS`.
2. Dari root repository jalankan `docker compose up --build`.
3. Buka API melalui `https://localhost`. Gateway membuat sertifikat self-signed
   untuk development; browser akan menampilkan peringatan sertifikat.

Compose menyiapkan PostgreSQL, Redis, API, dan Nginx API Gateway. API hanya
terekspos di jaringan Compose; akses database dan Redis dari host dibatasi ke
loopback untuk development. Port 80 mengalihkan ke HTTPS. Data database/cache
disimpan di named volumes.
`docker compose down -v` menghapus container dan data lokal.

## Enkripsi data dan backup

`EncryptionService` memakai AES-256-GCM dan menghasilkan envelope biner
`version | panjang ID kunci | ID kunci | IV | ciphertext | authentication tag`.
AAD wajib diberikan dengan konteks stabil, misalnya
`kontak_darurat:no_telepon_enc:<id_kontak>`. Ciphertext yang dipindah ke baris
atau kolom lain akan gagal didekripsi. Kolom sensitif `*_enc` di skema database
menyimpan hasil enkripsi ini; jangan menulis plaintext ke log.

Untuk menjalankan lokal, salin `.env.example` ke `.env`. `ENCRYPTION_KEY_1`
adalah kunci development contoh; ganti dengan kunci acak 32 byte sebelum
menyimpan data nyata. Buat nilainya dengan
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Kunci produksi simpan di secret manager, bukan di Git atau database. Saat rotasi,
tambahkan kunci baru dengan ID baru (mis. `ENCRYPTION_KEY_2`), ubah
`ENCRYPTION_ACTIVE_KEY_ID`, lalu enkripsi ulang data lama secara bertahap
sebelum mencabut kunci lama.

Backup harian diaktifkan setelah key age disiapkan. Di PowerShell, buat keypair
di luar repo dengan `age-keygen -o "$env:USERPROFILE\backup.agekey"`. Simpan
identity privat tersebut dengan aman, lalu masukkan recipient publik (`age1...`)
yang dicetak perintah itu ke `BACKUP_AGE_RECIPIENT` di `.env`.
Jalankan `docker compose --profile backup up -d --build`. Service membuat backup
pertama saat start, lalu mengulang setiap 24 jam; kegagalan dicoba lagi setelah
5 menit. File `pg_dump` dienkripsi dengan age sebelum ditulis ke `backups/`,
memiliki mode file terbatas, dan backup lokal yang lebih lama dari 14 hari
dihapus. Interval dan retensi dapat diatur melalui `BACKUP_INTERVAL_SECONDS`
dan `BACKUP_RETENTION_DAYS`.

Untuk restore, dekripsi file `.dump.age` menggunakan identity privat age, lalu
pulihkan arsip custom-format dengan `pg_restore` ke database kosong. Role
`denger_app` dan `denger_report` harus sudah tersedia; sinkronkan backup terenkripsi
ke penyimpanan terpisah agar tetap tersedia bila host lokal gagal.

Untuk deployment, set `TLS_MODE=production` dan pasang sertifikat tepercaya
sebagai `/etc/nginx/certs/tls.crt` dan `/etc/nginx/certs/tls.key`. Gateway akan
gagal start jika sertifikat tidak tersedia. Atur `GATEWAY_HTTPS_PORT`,
`GATEWAY_HTTP_PORT`, dan `CORS_ORIGINS` sesuai domain deployment. Jangan gunakan
sertifikat self-signed development untuk lingkungan publik.

## Database migrations

- `npm run migration:show` melihat status migrasi.
- `npm run migration:run` menerapkan migrasi.
- `npm run migration:revert` membatalkan migrasi terakhir.
- `npm run migration:generate -- src/database/migrations/NamaMigrasi` membuat
  draft migrasi dari entity TypeORM.

Skema `0001_init.sql` mengikuti DDL di `04-database.md`; migrasi TypeORM
membacanya dari `src/database/sql`. Salinan referensi tersedia di
`infra/db/schema.sql`. Migrasi berikutnya membuat role `denger_app` dan
`denger_report`; `APP_DB_PASSWORD` dan `REPORT_DB_PASSWORD` wajib diset untuk
migrasi. Service `migrate` memakai `MIGRATION_DATABASE_URL` milik owner DB;
service API hanya menerima `DATABASE_URL` untuk `denger_app` dan
`REPORT_DATABASE_URL` untuk `denger_report`. Kredensial default Compose hanya
untuk development lokal. `synchronize` tetap nonaktif.

## Scripts
- start:dev
- build
- migration:run
- migration:revert
- migration:generate
- seeder
- test / test:e2e
