# DIA API (NestJS Modular Monolith)

Setup sesuai dokumen dia-backend/02-backend.md.

## Docker Compose (development)

1. Opsional: salin `.env.example` di root repo ke `.env` dan ganti kredensial
   untuk lingkungan selain development lokal.
2. Dari root repository jalankan `docker compose up --build`.
3. Compose menunggu migrasi selesai sebelum menjalankan API di
   `http://localhost:3000`.

Compose menyiapkan PostgreSQL, Redis, dan API. Data database/cache disimpan di
named volumes. `docker compose down -v` menghapus container dan data lokal.

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
