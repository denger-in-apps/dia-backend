# PBI-19 Direktori Sumber Daya — SCRUM-270

**Description**

Sebagai mahasiswa dan psikolog, saya ingin melihat kontak layanan bantuan; sebagai dosen admin, saya ingin mengelolanya.

**Referensi proposal:** Tabel 5.1 Sprint 4 (Pendampingan & Dukungan Mahasiswa); Bab 4.1 Use Case: Direktori Sumber Daya; Bab 4.3 ERD: `SUMBER_DAYA`; FR: FR-MHS-10, FR-PSI-07, FR-ADM-03.

## Direktori (mahasiswa, psikolog, publik)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/sumber-daya?kategori=` | Entri **aktif**: hotline nasional dulu, lalu unit kesehatan kampus, RS rujukan, komunitas sebaya |
| GET | `/sumber-daya/:id` | Detail entri aktif |

`kategori`: `UNIT_KESEHATAN_KAMPUS` · `RUMAH_SAKIT_RUJUKAN` · `HOTLINE_NASIONAL` · `KOMUNITAS_SEBAYA`.

Endpoint baca sengaja **publik** (`@Public()`, tanpa token): isinya kontak layanan bantuan yang
tidak sensitif, dan harus tetap terbuka bagi mahasiswa yang aksesnya dibatasi (status akademik
tidak aktif, FR-MHS-02) maupun saat SSO/API akademik gangguan (02-backend.md §6). Tetap terkena
rate limit global 100 req/menit/IP.

## Pengelolaan (Dosen Admin)

Prefix `/api/v1`, Bearer token, hanya role `DOSEN_ADMIN`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/sumber-daya?kategori=` | Semua entri termasuk nonaktif |
| POST | `/admin/sumber-daya` | `{ nama (2–120), kategori, kontak (3–200), deskripsi? (≤1000), aktif? }` |
| PATCH | `/admin/sumber-daya/:id` | Ubah sebagian; `aktif: false` menyembunyikan dari direktori tanpa menghapus |
| DELETE | `/admin/sumber-daya/:id` | Hapus permanen |

- `kontak` berupa teks bebas satu baris (nomor telepon, email, alamat, atau URL).
- `id_dosen` diisi admin yang terakhir membuat/mengubah entri (penanggung jawab).
- Audit: `SUMBER_DAYA_BUAT`, `SUMBER_DAYA_UBAH` (dengan daftar field), `SUMBER_DAYA_HAPUS`.

> ⚠️ **Sebelum rilis:** direktori belum di-seed karena kontak harus diverifikasi
> (04-database.md §7). Dosen Admin mengisi entri awal, minimal **Healing119.id — 119 ext. 8**
> (`HOTLINE_NASIONAL`) dan layanan kesehatan kampus.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/sumber-daya
curl.exe -k -s "https://localhost:18443/api/v1/sumber-daya?kategori=HOTLINE_NASIONAL"
```

## Kriteria penerimaan PBI-19

- [x] Mahasiswa dan psikolog (bahkan tanpa login) dapat melihat direktori layanan bantuan aktif per kategori.
- [x] Dosen Admin dapat menambah, mengubah, menonaktifkan, dan menghapus entri; setiap perubahan diaudit.
