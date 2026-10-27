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
