# DIA API (NestJS Modular Monolith)

Setup sesuai dokumen dia-backend/02-backend.md.

## Menjalankan dan mengetes backend

### Persiapan (PowerShell)

Jalankan perintah dari folder utama repository (`dia-backend`):

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Buat key JWT development sekali saja, bila `infra/auth/jwt_private.pem` dan
`infra/auth/jwt_public.pem` belum ada:

```powershell
node infra/auth/generate-dev-jwt-keys.cjs
```

File privat berada di `infra/auth/` dan diabaikan Git. Jangan menimpa key yang
sudah digunakan untuk data atau sesi yang ingin dipertahankan.

### Jalankan service

```powershell
docker compose up --build -d
docker compose ps
```

Compose menjalankan PostgreSQL, Redis, migrasi, API, dan Nginx gateway. Tunggu
sampai `postgres` dan `redis` berstatus `healthy`, `api` dan `gateway` berstatus
`Up`, serta `migrate` selesai dengan kode `0`. Baris `No migrations are pending`
berarti database sudah memiliki semua migrasi.

Port default gateway adalah 80 (HTTP) dan 443 (HTTPS). Jika port tersebut sudah
dipakai, ubah `GATEWAY_HTTP_PORT` dan `GATEWAY_HTTPS_PORT` di `.env`, misalnya:

```dotenv
GATEWAY_HTTP_PORT=18080
GATEWAY_HTTPS_PORT=18443
```

Setelah mengubah port, jalankan kembali `docker compose up -d`.

### Cek API

Untuk konfigurasi port contoh di atas, dari PowerShell jalankan:

```powershell
curl.exe -k -i https://localhost:18443/health/live
curl.exe -k -i https://localhost:18443/health/ready
```

Ganti `18443` dengan nilai `GATEWAY_HTTPS_PORT` di `.env`. Respons yang
diharapkan adalah HTTP `200` dengan body `{"status":"ok"}`. Opsi `-k`
mengizinkan sertifikat self-signed yang dibuat gateway untuk development.
Alternatifnya, buka URL endpoint health tersebut di browser dan lanjutkan
melewati peringatan sertifikat lokal.

Untuk melihat log API (bukan log migrasi):

```powershell
docker compose logs -f api
```

Log `Nest application successfully started` menandakan API berhasil mulai.
Log migrasi dapat dilihat terpisah dengan `docker compose logs migrate`.
Login staf hanya tersedia untuk akun yang sudah diprovisikan; pendaftaran dan
reset password staf berada di luar subtask login ini.

### Menjalankan unit test

Dari folder API:

```powershell
cd apps/api
npm ci
npm test -- --runInBand
```

Untuk memastikan TypeScript dapat dikompilasi:

```powershell
npm run build
```

Unit test auth memakai OIDC strategy dan layanan database palsu, jadi tidak
memerlukan akun kampus. Untuk menjalankan tes e2e aplikasi terhadap service
Compose yang aktif:

```powershell
docker compose exec api npm run test:e2e -- --runInBand
```

Untuk membuat akun login uji lokal dan menjalankan smoke test auth end-to-end,
dari root repository jalankan:

```powershell
docker compose exec -e DEV_AUTH_SEED=true -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run seed:dev-auth
docker compose exec -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run test:auth:smoke
```

Seeder hanya berjalan saat `NODE_ENV=development` dan `DEV_AUTH_SEED=true`.
Seeder menyiapkan `admin.test@denger.local`, `psikolog.test@denger.local`, serta
mahasiswa aktif `TEST-DEV-0001`; kata sandi di-hash dengan Argon2id. Jalankan
ulang seed untuk mengatur ulang password akun uji. Password tersebut khusus
development, jangan dipakai ulang untuk akun nyata.

### Uji login OIDC dengan provider

Isi nilai berikut di `.env` dari detail provider OIDC yang dipakai. Jangan
commit client secret:

```dotenv
OIDC_ISSUER_URL=https://issuer-provider
OIDC_CLIENT_ID=client-id
OIDC_CLIENT_SECRET=client-secret
OIDC_REDIRECT_URI=https://localhost:18443/api/v1/auth/sso/callback
OIDC_NIM_CLAIM=nim
```

Daftarkan nilai `OIDC_REDIRECT_URI` yang sama persis sebagai callback URL di
provider. Jika memakai port gateway selain `18443`, ganti portnya di kedua
tempat. Provider harus menerbitkan klaim `sub`, `email`, `email_verified: true`,
dan klaim NIM sesuai `OIDC_NIM_CLAIM`.

Untuk prototipe ini, akun mahasiswa harus sudah memiliki baris dengan
`status_aktif = true`; integrasi pemeriksaan status akademik merupakan bagian
PBI-02 dan belum dipanggil oleh login. Buat akun uji lokal dengan NIM/email
khusus melalui database owner. Sesuaikan NIM dan email dengan klaim akun OIDC:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "INSERT INTO mahasiswa (nim, nama, email, status_aktif) VALUES ('20260001', 'Mahasiswa Uji', 'mahasiswa.uji@example.edu', true) ON CONFLICT (nim) DO UPDATE SET status_aktif = true"
```

Lalu buka:

```text
https://localhost:18443/api/v1/auth/sso/login
```

Setelah callback berhasil, API menyimpan refresh token dalam cookie aman dan
mengarahkan pengguna ke `FRONTEND_LOGIN_SUCCESS_URL`. Frontend kemudian meminta
`POST /api/v1/auth/refresh` dengan cookie (`credentials: 'include'`) untuk
mendapatkan access token. Atur `CORS_ORIGINS` dan URL redirect sesuai origin
frontend yang digunakan. Login SSO sungguhan memerlukan issuer dan client
credentials dari provider; unit test tidak menghubungi provider eksternal.
Jika provider menolak login, callback mengarahkan frontend dengan `error=kredensial`;
gangguan provider memakai `error=sso_gangguan`; akun mahasiswa nonaktif memakai
`error=akun_tidak_aktif`; callback atau klaim yang tidak valid memakai
`error=sso_gagal`.

`npm run start` menjalankan API langsung di host, bukan di container. Jalur ini
memerlukan environment lokal seperti `DATABASE_URL`, key enkripsi, key JWT, dan
Redis. Untuk pengujian paling sederhana, jalankan API lewat Compose dan gunakan
health endpoint di atas.

### Menghentikan service

```powershell
docker compose down
```

Perintah itu mempertahankan data database dan Redis. `docker compose down -v`
menghapus volume beserta data development lokal.

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

## Autentikasi PBI-01

- `POST /api/v1/auth/staff/login` menerima `{ "role": "PSIKOLOG" | "DOSEN_ADMIN", "email": "...", "password": "...", "otp": "..."? }`.
- `GET /api/v1/auth/sso/login` memulai OIDC Authorization Code + PKCE; callback adalah `GET /api/v1/auth/sso/callback`.
- `POST /api/v1/auth/refresh` merotasi refresh cookie; `POST /api/v1/auth/logout` mencabut seluruh keluarga token.
- `GET /api/v1/auth/me` memerlukan `Authorization: Bearer <accessToken>`.

Endpoint login staf dibatasi 5 percobaan per menit dan awal login SSO 10
percobaan per menit per alamat IP (rate limit in-memory untuk prototipe satu
instance). Refresh tanpa cookie valid membalas 401; refresh dan logout memerlukan
header `Origin` yang cocok dengan salah satu nilai `CORS_ORIGINS`.

Access token RS256 berlaku 15 menit; refresh token acak disimpan hanya sebagai
SHA-256 hash dan dikirim lewat cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
Gunakan `REFRESH_COOKIE_SAME_SITE=none` bila FE/API benar-benar lintas-site.
Jika refresh token lama digunakan kembali, semua token dalam keluarganya dicabut.
`RolesGuard` dan `@Roles(...)` tersedia untuk endpoint yang dibatasi peran.

Untuk mengaktifkan SSO, isi `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, dan nama klaim NIM dari IT kampus.
Klaim email harus ditandai terverifikasi. Status mahasiswa dicek fail-closed
melalui `mahasiswa.status_aktif`; PBI-02 perlu mengisi status hasil verifikasi
akademik sebelum sesi diterbitkan. Akun staf harus lebih dulu diprovisikan;
psikolog hanya dapat login setelah `status_akun = 'AKTIF'`.

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
