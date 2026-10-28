# PBI-02 [BE] Verifikasi Mahasiswa Aktif

Sebagai sistem, saya ingin memeriksa status keaktifan mahasiswa agar hanya mahasiswa aktif yang dapat memakai layanan.

**Referensi proposal:** Tabel 5.1 Sprint 1 (Fondasi Sistem & Autentikasi); Bab 4.1 Use Case: Verifikasi Mahasiswa Aktif; Bab 4.3 ERD: `MAHASISWA.status_aktif`; FR-MHS-02.

## Tujuan dan aturan

- Mahasiswa harus berstatus aktif untuk menerima sesi setelah login SSO.
- Status bersumber dari adapter akademik dan disimpan di `mahasiswa.status_aktif` beserta `mahasiswa.terakhir_verifikasi_at`.
- Status akademik dicache di Redis dengan key `akademik:{nim}` selama maksimal 24 jam.
- Timeout integrasi akademik adalah 3 detik.
- Jika integrasi gagal, akun aktif boleh memakai hasil DB yang diverifikasi dalam 24 jam terakhir. Akun baru yang belum pernah diverifikasi ditolak (fail-closed).
- Status nonaktif menghasilkan `403 AKUN_TIDAK_AKTIF`; callback SSO mengarahkan frontend dengan `error=akun_tidak_aktif` dan tidak menerbitkan sesi.
- Status mahasiswa diperiksa di callback SSO, saat refresh token, dan saat akses API mahasiswa. Pemeriksaan ulang ke sumber akademik dilakukan saat waktu verifikasi telah mencapai 24 jam.

## Implementasi adapter

`AkademikModule` menyediakan interface `AkademikClient` dan dua implementasi:

| Mode | Penggunaan | Perilaku |
|---|---|---|
| `mock` | Development lokal | NIM yang tercantum di `AKADEMIK_MOCK_ACTIVE_NIMS` aktif; NIM lain nonaktif. |
| `http` | Integrasi API akademik | Meminta `AKADEMIK_STATUS_URL?nim={nim}` dengan bearer token dan mengharapkan JSON `{ "aktif": boolean }`. |

Format request dan response HTTP masih asumsi sementara karena kontrak API kampus belum tersedia. Cocokkan adapter dengan dokumentasi resmi sebelum menghubungkannya ke sistem kampus. Mode produksi mewajibkan `AKADEMIK_MODE=http` dan HTTPS.

Konfigurasi lokal di `.env`:

```dotenv
AKADEMIK_MODE=mock
AKADEMIK_MOCK_ACTIVE_NIMS=TEST-DEV-0001
```

Konfigurasi integrasi HTTP:

```dotenv
AKADEMIK_MODE=http
AKADEMIK_STATUS_URL=https://akademik.example.edu/api/v1/mahasiswa/status
AKADEMIK_API_TOKEN=<token-dari-secret-manager>
```

Setelah konfigurasi diubah, recreate API agar environment baru terbaca:

```powershell
docker compose up -d --force-recreate api
```

## Persiapan data uji

Gunakan data dari seeder PBI-01; tidak perlu membuat akun atau NIM tambahan.
Seeder membuat mahasiswa `TEST-DEV-0001` dengan email
`mahasiswa.test@denger.local` dalam keadaan aktif. Jalankan dari root repository
jika data belum ada:

```powershell
docker compose exec -e DEV_AUTH_SEED=true -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run seed:dev-auth
```

Untuk login SSO, provider OIDC development harus mengirim klaim `sub`, email
dengan `email_verified: true`, dan `nim: TEST-DEV-0001`. Konfigurasikan
`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI`, dan `OIDC_NIM_CLAIM=nim` pada `.env`; daftarkan callback URL
yang sama di provider. Detail persiapan OIDC ada di
[panduan testing PBI-01](PBI-01-auth-testing.md#login-sso-oidc).

## Skenario uji manual

Jalankan database, Redis, API, dan gateway. Pastikan `AKADEMIK_MODE=mock`, NIM
seed ada di `AKADEMIK_MOCK_ACTIVE_NIMS`, dan konfigurasi OIDC sudah tersedia.
Untuk port gateway contoh `18443`, URL API adalah
`https://localhost:18443/api/v1`.

### 1. Mahasiswa aktif dapat login

Atur mock agar menganggap mahasiswa seed aktif:

```dotenv
AKADEMIK_MOCK_ACTIVE_NIMS=TEST-DEV-0001
```

Recreate API, hapus cache lama jika ada, lalu mulai login melalui browser:

```powershell
docker compose up -d --force-recreate api
docker compose exec redis redis-cli DEL akademik:TEST-DEV-0001
```

```text
https://localhost:18443/api/v1/auth/sso/login
```

Login dengan akun OIDC yang mengirim NIM seed. Hasil yang diharapkan: callback
berhasil, sesi diterbitkan, dan baris mahasiswa memiliki status aktif serta
waktu verifikasi:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "SELECT nim, status_aktif, terakhir_verifikasi_at FROM mahasiswa WHERE nim = 'TEST-DEV-0001'"
```

Nilai yang diharapkan adalah `status_aktif = t` dan `terakhir_verifikasi_at`
terisi.

### 2. Mahasiswa nonaktif ditolak

Kosongkan daftar NIM aktif, recreate API, hapus cache, lalu ulangi login dengan
akun OIDC seed yang sama:

```dotenv
AKADEMIK_MOCK_ACTIVE_NIMS=
```

```powershell
docker compose up -d --force-recreate api
docker compose exec redis redis-cli DEL akademik:TEST-DEV-0001
```

Hasil yang diharapkan: tidak ada sesi; frontend menerima
`error=akun_tidak_aktif`; baris seed tetap ada dengan `status_aktif = f`.
Verifikasi database dengan query pada skenario pertama.

### 3. Access token lama ditolak setelah status dicabut

Login lagi setelah mock diatur aktif dan simpan access token yang diterbitkan.
Kemudian ubah status di DB menjadi nonaktif dan panggil endpoint profil:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "UPDATE mahasiswa SET status_aktif = false WHERE nim = 'TEST-DEV-0001'"
curl.exe -k -i https://localhost:18443/api/v1/auth/me -H "Authorization: Bearer ACCESS_TOKEN"
```

Hasil yang diharapkan: HTTP `403` dengan kode `AKUN_TIDAK_AKTIF`.

### 4. Pulihkan data seed

Kembalikan NIM ke daftar aktif, recreate API, hapus cache status, lalu login SSO
lagi. Verifikasi `status_aktif = t` dan waktu verifikasi terbaru.

```dotenv
AKADEMIK_MOCK_ACTIVE_NIMS=TEST-DEV-0001
```

```powershell
docker compose up -d --force-recreate api
docker compose exec redis redis-cli DEL akademik:TEST-DEV-0001
```

## Kriteria penerimaan

- [ ] Mahasiswa aktif yang lolos verifikasi memperoleh sesi.
- [ ] Status dan waktu verifikasi tersimpan sesuai hasil adapter.
- [ ] Mahasiswa nonaktif tidak memperoleh sesi dan menerima kode `AKUN_TIDAK_AKTIF`.
- [ ] Access token mahasiswa dengan status DB nonaktif ditolak oleh API.
- [ ] Cache status berlaku maksimal 24 jam.
- [ ] Saat layanan akademik gagal, akun yang terakhir diverifikasi aktif dalam 24 jam dapat lanjut; akun baru gagal tertutup.
- [ ] Token akses maupun data sensitif tidak memuat NIM.

## Batasan saat ini

- Integrasi HTTP belum dapat dianggap siap untuk kampus sampai kontrak endpoint,
  autentikasi layanan, dan bentuk respons resmi dikonfirmasi.
- Verifikasi akademik dijalankan ketika mahasiswa login atau melakukan request
  setelah hasil verifikasinya kedaluwarsa; bukan job berkala terpisah.
- Aturan izin terbatas untuk direktori sumber daya/hotline bagi akun nonaktif
  perlu diterapkan pada endpoint fitur terkait saat modul-modul tersebut dibuat.
