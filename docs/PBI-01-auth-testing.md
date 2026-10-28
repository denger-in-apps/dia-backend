# PBI-01 — Panduan testing autentikasi

Panduan ini mencakup tes unit, tes integrasi lokal untuk login staf, dan tes
login mahasiswa melalui provider OIDC. Jalankan perintah Docker dari root repo
`dia-backend`, kecuali jika disebutkan lain.

## 1. Persiapan service

Pastikan service development aktif:

```powershell
docker compose ps
```

`postgres` dan `redis` harus `healthy`; `api` dan `gateway` harus `Up`. Service
`migrate` boleh berstatus `Exited (0)`. Pesan `No migrations are pending`
berarti skema database sudah mutakhir.

Tes health endpoint melalui gateway development:

```powershell
curl.exe -k -i https://localhost:18443/health/live
```

Respons yang diharapkan: HTTP `200` dan `{"status":"ok"}`. Sesuaikan port
`18443` dengan `GATEWAY_HTTPS_PORT` di `.env`. Opsi `-k` menerima sertifikat
self-signed development.

Jika API belum berjalan, siapkan `.env` dan key JWT development sesuai
[panduan API](apps/api/README.md#menjalankan-dan-mengetes-backend), lalu mulai:

```powershell
docker compose up --build -d
```

Lihat log API dengan `docker compose logs -f api`. Log yang dicari adalah
`Nest application successfully started`.

## 2. Tes otomatis

Dari folder API, jalankan unit test autentikasi dan seluruh unit test:

```powershell
cd apps/api
npm test -- --runInBand src/common/auth
npm test -- --runInBand
npm run typecheck
npm run build
```

Tes autentikasi mencakup OIDC state, nonce dan PKCE, validasi klaim, login staf,
validasi input, refresh token, deteksi reuse, throttling, proteksi Origin, dan
endpoint `/auth/me`. Tes ini memakai dependency mock sehingga tidak perlu akun
atau kredensial provider kampus.

Jalankan tes e2e terhadap service Compose aktif dari root repo:

```powershell
docker compose exec api npm run test:e2e -- --runInBand
```

## 3. Buat dan uji akun staf development

Seeder membuat atau memperbarui akun khusus development berikut:

| Role | Email | Password development |
|---|---|---|
| `DOSEN_ADMIN` | `admin.test@denger.local` | `DengerTest-2026!` |
| `PSIKOLOG` | `psikolog.test@denger.local` | `DengerTest-2026!` |

Psikolog uji dibuat aktif dan tercatat diverifikasi oleh Admin Uji. Seeder juga
membuat profil mahasiswa aktif `TEST-DEV-0001` untuk dipakai setelah OIDC
dikonfigurasi.

Jalankan seeder dan smoke test dari root repo:

```powershell
docker compose exec -e DEV_AUTH_SEED=true -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run seed:dev-auth
docker compose exec -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run test:auth:smoke
```

Hasil yang diharapkan:

```text
DOSEN_ADMIN: login, /me, refresh, logout OK
PSIKOLOG: login, /me, refresh, logout OK
```

Smoke test memakai API dan PostgreSQL yang benar-benar berjalan. Untuk setiap
role, test melakukan login, mengambil profil melalui `/auth/me`, merotasi refresh
token, lalu logout.

Seeder hanya berjalan jika `NODE_ENV=development` dan `DEV_AUTH_SEED=true`.
Menjalankan ulang seeder mengatur ulang password dua akun khusus tersebut.
Gunakan password ini hanya untuk database lokal development; jangan gunakan
atau salin ke lingkungan produksi.

## 4. Perilaku endpoint yang diharapkan

Base URL lokal dengan konfigurasi port contoh:

```text
https://localhost:18443/api/v1
```

| Request | Hasil yang diharapkan |
|---|---|
| `POST /auth/staff/login` dengan akun uji yang valid | HTTP `200`, access token di JSON, refresh token di cookie `HttpOnly` |
| `POST /auth/staff/login` dengan password salah | HTTP `401` |
| `GET /auth/me` tanpa bearer token | HTTP `401` |
| `GET /auth/me` dengan access token valid | HTTP `200`, profil dan role akun |
| `POST /auth/refresh` tanpa refresh cookie | HTTP `401` |
| `POST /auth/refresh` dengan Origin tidak diizinkan | HTTP `403` |
| `POST /auth/logout` dengan Origin valid dan cookie sesi | HTTP `204` |

Login staf dibatasi 5 percobaan per menit per alamat IP. Endpoint awal login OIDC
dibatasi 10 percobaan per menit per IP.

## 5. Uji verifikasi mahasiswa aktif (PBI-02)

Pakai mahasiswa yang sudah disiapkan seeder PBI-01: `TEST-DEV-0001` /
`mahasiswa.test@denger.local`. Seeder membuatnya aktif. PBI-02 menentukan status
login dari adapter akademik mock, jadi NIM tersebut juga harus dimasukkan ke
daftar mock di `.env`. Siapkan provider OIDC development dengan klaim `sub`,
email terverifikasi, dan NIM `TEST-DEV-0001`.

Jalankan seeder yang ada di bagian 3 bila belum dijalankan:

```powershell
docker compose exec -e DEV_AUTH_SEED=true -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run seed:dev-auth
```

Tambahkan satu NIM aktif ke `.env`:

```dotenv
AKADEMIK_MODE=mock
AKADEMIK_MOCK_ACTIVE_NIMS=TEST-DEV-0001
```

Isi konfigurasi OIDC di bagian berikut, lalu muat ulang API agar konfigurasi
dibaca ulang:

```powershell
docker compose up -d --force-recreate api
```

Login melalui `https://localhost:18443/api/v1/auth/sso/login` dengan pengguna
uji yang memiliki klaim NIM `TEST-DEV-0001`. Setelah login sukses, periksa
status hasil verifikasi tersimpan:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "SELECT nim, status_aktif, terakhir_verifikasi_at FROM mahasiswa WHERE nim = 'TEST-DEV-0001'"
```

Hasil yang diharapkan: satu baris dengan `status_aktif = t` dan waktu verifikasi
terisi. Callback sukses juga menerbitkan sesi (redirect ke URL sukses).

Untuk uji mahasiswa tidak aktif, kosongkan daftar NIM aktif, muat ulang API,
hapus cache NIM seed, lalu login lagi dengan akun OIDC yang sama (NIM
`TEST-DEV-0001`):

```dotenv
AKADEMIK_MOCK_ACTIVE_NIMS=
```

```powershell
docker compose up -d --force-recreate api
docker compose exec redis redis-cli DEL akademik:TEST-DEV-0001
```

Hasil yang diharapkan: tidak ada sesi dan frontend diarahkan dengan
`error=akun_tidak_aktif`. Baris mahasiswa seed tetap ada, tetapi nilai
`status_aktif` diperbarui menjadi `false`. Cek dengan:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "SELECT nim, status_aktif, terakhir_verifikasi_at FROM mahasiswa WHERE nim = 'TEST-DEV-0001'"
```

Untuk memastikan status aktif dicabut dan token yang sudah terbit tidak lagi
diterima, login saat mock masih menganggap `TEST-DEV-0001` aktif dan ambil access
token dari sesi. Lalu jalankan:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "UPDATE mahasiswa SET status_aktif = false WHERE nim = 'TEST-DEV-0001'"
curl.exe -k -i https://localhost:18443/api/v1/auth/me -H "Authorization: Bearer ACCESS_TOKEN"
```

Hasil yang diharapkan: HTTP `403` dengan `AKUN_TIDAK_AKTIF`. Login ulang
memerlukan verifikasi akademik yang menyatakan mahasiswa aktif. Untuk memulihkan
akun seed, kembalikan `AKADEMIK_MOCK_ACTIVE_NIMS=TEST-DEV-0001`, recreate API,
hapus key cache `akademik:TEST-DEV-0001`, lalu login SSO lagi.

### Login SSO OIDC

Tes ini memerlukan provider OIDC yang dapat dijangkau API. Isi nilai berikut di
`.env` memakai konfigurasi provider development yang disediakan kampus atau
tim:

```dotenv
OIDC_ISSUER_URL=https://issuer-provider
OIDC_CLIENT_ID=client-id
OIDC_CLIENT_SECRET=client-secret
OIDC_REDIRECT_URI=https://localhost:18443/api/v1/auth/sso/callback
OIDC_NIM_CLAIM=nim
```

Daftarkan `OIDC_REDIRECT_URI` yang persis sama pada provider. Jika port gateway
berbeda, ubah URI tersebut dan callback URL di provider. Provider harus
menerbitkan klaim `sub`, `email`, `email_verified: true`, dan klaim NIM yang
sesuai dengan `OIDC_NIM_CLAIM`.

Atur akun OIDC development agar klaim NIM-nya `TEST-DEV-0001`. Pemeriksaan ini
disimulasikan oleh adapter
mock; untuk menguji integrasi kampus yang sesungguhnya, gunakan mode `http`
setelah kontrak API akademik resmi tersedia.

Setelah mengubah `.env`, muat ulang API:

```powershell
docker compose up -d api
```

Buka URL berikut di browser untuk memulai login:

```text
https://localhost:18443/api/v1/auth/sso/login
```

Alur yang diharapkan: redirect ke provider → autentikasi pengguna uji → callback
ke API → refresh cookie aman dibuat → redirect ke
`FRONTEND_LOGIN_SUCCESS_URL`. Frontend mengambil access token dengan
`POST /api/v1/auth/refresh` dan menyertakan cookie (`credentials: 'include'`).
Atur `CORS_ORIGINS` serta URL sukses/gagal sesuai origin frontend.

Jika issuer/client belum dikonfigurasi, endpoint login OIDC akan menolak memulai
login. Error callback diarahkan ke frontend dengan salah satu kode berikut:

- `kredensial`: provider menolak autentikasi.
- `akun_tidak_aktif`: profil mahasiswa tidak aktif.
- `sso_gangguan`: provider tidak dapat dijangkau atau mengalami gangguan.
- `sso_gagal`: callback atau klaim tidak valid.

## 6. Menutup service

```powershell
docker compose down
```

Perintah ini mempertahankan akun dan data lokal di volume PostgreSQL. Untuk
menghapus seluruh database development beserta akun uji, gunakan
`docker compose down -v`.
