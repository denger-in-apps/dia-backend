# PBI-04 [BE] Hak Akses Pengguna (RBAC)

**Description**

Sebagai sistem, saya ingin membatasi akses berdasarkan peran agar data sensitif terlindungi.

**Referensi proposal:** Tabel 5.1 Sprint 1 (Fondasi Sistem & Autentikasi); Bab 4.1 Use Case: tidak ada use case khusus; Bab 4.3 ERD: `MAHASISWA`, `PSIKOLOG`, `DOSEN_ADMIN`; FR: tidak dicantumkan pada PBI.

## Peran pengguna

Role disimpan dalam klaim JWT dan disesuaikan dengan tipe PostgreSQL `role_pengguna`:

| Role | Identitas | Syarat akun aktif |
|---|---|---|
| `MAHASISWA` | `mahasiswa.id_mahasiswa` | `status_aktif = true` dan belum dihapus |
| `PSIKOLOG` | `psikolog.id_psikolog` | `status_akun = 'AKTIF'` |
| `DOSEN_ADMIN` | `dosen_admin.id_dosen` | `aktif = true` |

Role bukan pengganti pemeriksaan kepemilikan. Service fitur tetap harus membatasi query menggunakan ID dari `@CurrentUser()`, misalnya `WHERE id_mahasiswa = :userId`, bukan mempercayai ID pemilik dari body atau parameter URL.

## Kebijakan penjagaan endpoint

- `JwtAuthGuard` dipasang sebagai global guard. Secara default semua endpoint memerlukan access token Bearer yang valid.
- `RolesGuard` juga global. Controller tanpa metadata role terbuka untuk semua pengguna yang sudah terautentikasi; gunakan `@Roles(...)` untuk mempersempitnya.
- `JwtAuthGuard` membaca status akun terkini di DB untuk ketiga role pada setiap request. Mahasiswa juga menjalani verifikasi akademik berkala PBI-02 saat hasil terakhir berumur 24 jam.
- Token valid dengan akun nonaktif menghasilkan HTTP `403 AKUN_TIDAK_AKTIF`; token yang hilang atau tidak valid menghasilkan HTTP `401`.
- Endpoint publik harus dinyatakan eksplisit dengan `@Public()`. Pengecualian saat ini adalah health check dan alur auth publik (`sso/login`, callback, login staf, refresh, logout). Refresh dan logout tetap memiliki pemeriksaan cookie dan Origin sendiri.
- Role yang tidak diizinkan menghasilkan HTTP `403`.

Contoh untuk controller fitur baru:

```ts
@Controller('psikolog/sos')
@Roles(Role.PSIKOLOG)
export class SosPsikologController {
  // JwtAuthGuard dan RolesGuard berlaku otomatis.
}
```

Controller boleh mencantumkan lebih dari satu role, misalnya
`@Roles(Role.MAHASISWA, Role.PSIKOLOG)`. Gunakan `@CurrentUser()` untuk identitas
yang sudah diverifikasi.

## Matriks akses ringkas

Turunan Tabel 3.4 pada proposal. Matriks ini menjadi panduan deklarasi peran
controller dan pemeriksaan domain pada service:

| Sumber daya | Mahasiswa | Psikolog | Dosen Admin |
|---|---|---|---|
| Profil & data pribadi sendiri | CRUD milik sendiri | Baca/ubah profil sendiri | Baca/ubah profil sendiri |
| Kontak darurat | CRUD milik sendiri | — | — |
| SOS | Buat dan baca milik sendiri | Antrean/kasus yang ditangani | Agregat saja |
| Lokasi SOS | — | Baca jika disetujui; wajib audit | — |
| Sesi konseling | Kelola milik sendiri | Kelola sesi sendiri | — |
| Ringkasan sesi | — | Kelola jika ada consent | — |
| Hasil cek mandiri | Kelola milik sendiri | — | Agregat saja |
| Curhat anonim | Buat/baca milik sendiri | Baca lewat view anonim dan membalas | — |
| Circle | Telusuri/gabung | Circle yang didampingi/moderasi | Kelola dan setujui |
| Sumber daya | Baca | Baca | Kelola |
| Akun psikolog, jadwal, konfigurasi SOS | — | Baca jadwal sendiri | Kelola |
| Audit log | — | — | Baca |
| Master data | Baca | Baca | Kelola |

Pembatasan agregat, anonimitas dan akses hanya-milik-sendiri juga harus ditegakkan
di query/service atau view database. Metadata role saja tidak cukup untuk itu.

## Cara memakai pada fitur berikutnya

1. Tambahkan `@Roles(...)` pada controller/resource yang membutuhkan pembatasan role.
2. Untuk endpoint lintas role, sebutkan hanya role yang memang diizinkan.
3. Ambil identitas dari `@CurrentUser()` lalu masukkan ID tersebut ke query ownership.
4. Akses data anonim/laporan melalui view atau role DB khusus sesuai panduan database.
5. Tandai endpoint tanpa login dengan `@Public()` hanya jika benar-benar perlu publik, dan tetap lakukan validasi/rate limit yang sesuai.

Tidak ada endpoint bisnis tambahan di PBI ini; controller fitur akan menerapkan
matriks saat masing-masing PBI dibuat. Health check dan route auth yang sudah
ada sudah diberi metadata publik secara eksplisit.

## Cara cek saat ini

Jalankan dari root repository. Pastikan Compose aktif dan buat akun uji bila
belum tersedia:

```powershell
docker compose exec -e DEV_AUTH_SEED=true -e DEV_AUTH_PASSWORD='DengerTest-2026!' api npm run seed:dev-auth
```

Health check harus publik, sementara `/auth/me` tanpa token harus ditolak:

```powershell
curl.exe -k -i https://localhost:18443/health/live
curl.exe -k -i https://localhost:18443/api/v1/auth/me
```

Hasil yang diharapkan: health `200`; `/auth/me` `401`.

Login sebagai dosen admin untuk mengambil access token, lalu panggil `/auth/me`:

```powershell
$login = curl.exe -k -sS -X POST https://localhost:18443/api/v1/auth/staff/login `
  -H "Content-Type: application/json" `
  --data-raw '{"role":"DOSEN_ADMIN","email":"admin.test@denger.local","password":"DengerTest-2026!"}' | ConvertFrom-Json

curl.exe -k -i https://localhost:18443/api/v1/auth/me `
  -H "Authorization: Bearer $($login.accessToken)"
```

Hasil yang diharapkan: login dan `/auth/me` `200`; profil mengandung role
`DOSEN_ADMIN`. Ulangi login dengan role `PSIKOLOG` dan email
`psikolog.test@denger.local`; profil harus ber-role `PSIKOLOG`. Password ini
hanya untuk data development dari seeder PBI-01.

Pengecekan ini membuktikan auth global, route publik, dan validasi akun aktif.
Saat ini belum ada controller bisnis yang memakai `@Roles(...)`, jadi belum ada
route untuk membuktikan penolakan lintas-role secara manual. Setelah ada route
khusus, misalnya `@Roles(Role.PSIKOLOG)`, uji dengan token psikolog (harapan
`200`) dan token dosen admin (harapan `403`). Jangan menganggap hasil `/auth/me`
sebagai uji pembatasan role karena endpoint itu memang tersedia untuk semua role.

Untuk mengecek status akun, token dari akun yang dinonaktifkan harus ditolak
`403 AKUN_TIDAK_AKTIF`. Contoh untuk dosen admin development; pulihkan statusnya
setelah selesai:

```powershell
docker compose exec postgres psql -U denger_owner -d denger -c "UPDATE dosen_admin SET aktif = false WHERE email = 'admin.test@denger.local'"
curl.exe -k -i https://localhost:18443/api/v1/auth/me -H "Authorization: Bearer ACCESS_TOKEN"
docker compose exec postgres psql -U denger_owner -d denger -c "UPDATE dosen_admin SET aktif = true WHERE email = 'admin.test@denger.local'"
```

Ganti `ACCESS_TOKEN` dengan token yang diterbitkan sebelum akun dinonaktifkan.
Request saat akun nonaktif diharapkan menerima `403`.

## Kriteria penerimaan

- [ ] Request tanpa access token ditolak secara default.
- [ ] Health check dan endpoint auth yang dinyatakan publik tetap dapat dipanggil tanpa Bearer token.
- [ ] Akun nonaktif dari setiap role ditolak meskipun access token belum kedaluwarsa.
- [ ] `@Roles(...)` menerima pengguna yang rolenya cocok dan menolak role lain dengan HTTP `403` (perlu route bisnis ber-role; belum ada di PBI ini).
- [ ] Route tanpa `@Roles` tetap mensyaratkan autentikasi, namun mengizinkan semua role aktif.
- [ ] Service fitur menggunakan pemeriksaan ownership dan tidak mempercayai ID pengguna dari klien.
