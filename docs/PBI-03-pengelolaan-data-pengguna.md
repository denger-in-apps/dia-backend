# PBI-03 [BE] Pengelolaan Data Pengguna — SCRUM-213

**Description**

Sebagai mahasiswa, saya ingin melihat, mengubah, dan menghapus data milik saya agar saya mengontrol data pribadi.

**Referensi proposal:** Tabel 5.1 Sprint 1 (Fondasi Sistem & Autentikasi); Bab 4.1 Use Case: -; Bab 4.3 ERD: `MAHASISWA`; FR: FR-MHS-12.

## Endpoint

Semua endpoint berprefix `/api/v1`, memerlukan `Authorization: Bearer <accessToken>`,
dan hanya untuk role `MAHASISWA` (role lain mendapat `403`). Identitas pemilik
selalu diambil dari token; ID pemilik dari body/URL tidak pernah dipercaya.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/me` | Profil: `nim`, `nama`, `nama_tampilan`, `email`, status akademik |
| PATCH | `/me` | Ubah `nama_tampilan` (1–60 karakter; `null` untuk mengosongkan) |
| GET | `/me/export` | Unduh seluruh data milik sendiri (JSON, `Cache-Control: no-store`), dicatat `DATA_EKSPOR` |
| DELETE | `/me` | Hapus akun; body wajib `{ "konfirmasi": "HAPUS" }`, dicatat `DATA_HAPUS` |
| GET · POST | `/me/kontak-darurat` | Daftar / tambah kontak darurat (maks. 5) |
| PATCH · DELETE | `/me/kontak-darurat/:id` | Ubah / hapus kontak darurat milik sendiri |

### Data yang dapat diubah

`nim`, `nama`, dan `email` bersumber dari SSO kampus dan ditimpa setiap login,
sehingga tidak dapat diubah lewat API (field tersebut ditolak `400`). Nama yang
ingin ditampilkan mahasiswa disimpan di kolom baru `mahasiswa.nama_tampilan`
(migrasi `1793700000000-AkunMahasiswa`).

### Kontak darurat

Body `POST`: `{ "nama_kontak": "Ibu", "no_telepon": "0812-3456-7890", "hubungan": "Orang tua" }`.
Spasi, tanda hubung, titik, dan kurung pada nomor dibuang; nomor harus 8–15 digit
dan boleh diawali `+`. Nomor disimpan terenkripsi AES-256-GCM di `no_telepon_enc`
dengan AAD `kontak_darurat:no_telepon_enc:<id_kontak>`, sehingga ciphertext tidak
dapat dipindahkan ke baris lain. Melebihi 5 kontak → `422 KONTAK_DARURAT_PENUH`.
Kontak milik mahasiswa lain → `404 KONTAK_TIDAK_DITEMUKAN`.

### Ekspor data

Memuat profil, kontak darurat (nomor didekripsi), preferensi minat, riwayat SOS
(tanpa koordinat), hasil cek mandiri (skor dan tingkat), riwayat sesi, metadata
curhat, dan keanggotaan Circle. Isi terenkripsi milik layanan lain (pesan sesi
E2EE, ringkasan sesi psikolog) tidak disertakan.

### Hapus akun (soft delete + anonimisasi)

Dalam satu transaksi:

1. Ditolak `409 SOS_AKTIF` bila mahasiswa masih memiliki SOS berstatus
   `BARU`/`DIAMBIL`/`DITANGANI`/`ESKALASI` (fitur keselamatan).
2. Sesi terjadwal/berlangsung dibatalkan; `keluhan_awal_enc` dikosongkan.
3. Dihapus: kontak darurat, preferensi minat, keanggotaan Circle (beserta pesan),
   curhat (beserta balasan), kunci publik E2EE, notifikasi.
4. Dipertahankan tanpa identitas untuk statistik: skor cek mandiri (jawaban
   rinci dihapus) dan riwayat SOS (koordinat lokasi dihapus).
5. Semua refresh token dicabut; baris `mahasiswa` dianonimkan (`nim`, `nama`,
   `email`, `sso_subject` diganti/kosong) dan diberi `deleted_at`.
6. Catatan audit `DATA_HAPUS` ikut di transaksi yang sama.

Access token yang masih berlaku langsung ditolak (`403 AKUN_TIDAK_AKTIF`) karena
guard memeriksa `deleted_at`. Login SSO berikutnya dengan akun kampus yang sama
akan membuat akun baru yang kosong.

## Cara cek

Jalankan unit test:

```powershell
cd apps/api
npm test -- --runInBand src/modules/akun
```

Uji manual lewat gateway (ganti port dan token sesuai lingkungan):

```powershell
$h = @{ Authorization = "Bearer $token" }
curl.exe -k -i https://localhost:18443/api/v1/me -H "Authorization: Bearer $token"
curl.exe -k -i -X PATCH https://localhost:18443/api/v1/me -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"nama_tampilan":"Budi"}'
curl.exe -k -i -X POST https://localhost:18443/api/v1/me/kontak-darurat -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"nama_kontak":"Ibu","no_telepon":"081234567890"}'
curl.exe -k -o data-saya.json https://localhost:18443/api/v1/me/export -H "Authorization: Bearer $token"
curl.exe -k -i -X DELETE https://localhost:18443/api/v1/me -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"konfirmasi":"HAPUS"}'
```

## Kriteria penerimaan

- [x] Mahasiswa dapat melihat profil miliknya; role lain ditolak `403`, tanpa token `401`.
- [x] Mahasiswa dapat mengubah nama tampilan; field identitas SSO tidak dapat diubah.
- [x] Mahasiswa dapat mengelola kontak darurat miliknya; nomor tersimpan terenkripsi.
- [x] Mahasiswa dapat mengekspor seluruh data miliknya; ekspor tercatat di audit log.
- [x] Mahasiswa dapat menghapus akun dengan konfirmasi eksplisit; data pribadi dihapus/dianonimkan, sesi dicabut, dan penghapusan tercatat di audit log.
- [x] Penghapusan ditolak selama SOS milik mahasiswa masih berjalan.
