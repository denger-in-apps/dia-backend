# DIA API (NestJS Modular Monolith)

Setup sesuai dokumen dia-backend/02-backend.md.

## Docker Compose (development)

1. Dari root repository jalankan `docker compose up --build`.
2. API tersedia di `http://localhost:3000`; migrasi berjalan sebelum API start.

Compose menyiapkan PostgreSQL, Redis, dan API. Data database/cache disimpan di
named volumes. `docker compose down -v` menghapus container dan data lokal.

## Database migrations

- `npm run migration:show` melihat status migrasi.
- `npm run migration:run` menerapkan migrasi.
- `npm run migration:revert` membatalkan migrasi terakhir.
- `npm run migration:generate -- src/database/migrations/NamaMigrasi` membuat
  draft migrasi dari entity TypeORM.

`InitialCoreSchema` adalah baseline sementara berdasarkan entitas dan constraint
di `02-backend.md`. ERD kanonis (`04-database.md`) belum tersedia di repo;
lengkapi baseline setelah ERD disepakati. `synchronize` tetap nonaktif.

## Scripts
- start:dev
- build
- migration:run
- migration:revert
- migration:generate
- seeder
- test / test:e2e
