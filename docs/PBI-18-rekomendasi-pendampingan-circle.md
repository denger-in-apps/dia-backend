# PBI-18 Rekomendasi dan Pendampingan Circle — SCRUM-266, SCRUM-267

**Description**

Sebagai mahasiswa, saya ingin disarankan Circle yang relevan; sebagai psikolog, saya ingin mendampingi Circle agar interaksi aman.

**Referensi proposal:** Tabel 5.1 Sprint 4 (Pendampingan & Dukungan Mahasiswa); Bab 4.1 Use Case: Circle; Bab 4.3 ERD: `CIRCLE`, `KEANGGOTAAN_CIRCLE`, `PSIKOLOG`; FR: FR-MHS-07, FR-PSI-06.

## 1. Rekomendasi Circle (SCRUM-266)

Prefix `/api/v1`, Bearer token, hanya role `MAHASISWA`.

| Method | Path | Keterangan |
|---|---|---|
| GET · PUT | `/me/preferensi-minat` | Kategori minat saya · `{ id_kategori: uuid[] }` (maks. 5, ganti semua; `[]` menghapus) |
| GET | `/circles/rekomendasi?limit=` | `{ butuh_preferensi, rekomendasi[] }` (default 5, maks. 20) |

Mesin rekomendasi **berbasis aturan** (02-backend.md §9.3, tanpa ML), untuk Circle `AKTIF` yang
belum diikuti dan belum penuh:

```
skor = 3 × minat_cocok           (kategori Circle ada di preferensi saya)
     + 1 × sisa_kuota / kuota     (0–1: masih ada tempat)
     + 1 × min(pesan_14_hari / 20, 1)   (0–1: Circle hidup; pesan tersembunyi tidak dihitung)
```

Minat mendominasi; sisa kuota dan aktivitas memecah seri. Seri skor diurutkan nama. Setiap item
memuat `skor`, `sisa_kuota`, dan `alasan[]` yang dapat ditampilkan, mis.
`["Sesuai minat Anda: Akademik", "Masih ada 3 tempat", "Aktif dalam 2 minggu terakhir"]`.
Tanpa preferensi, `butuh_preferensi: true` — FE sebaiknya meminta mahasiswa memilih minat.

Preferensi minat ikut diekspor (`GET /me/export`) dan dihapus saat akun dihapus (PBI-03).

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/circle
```

## Kriteria penerimaan PBI-18 (rekomendasi)

- [x] Mahasiswa dapat menyimpan preferensi minat (kategori aktif, maks. 5).
- [x] Mahasiswa menerima rekomendasi Circle yang relevan beserta alasannya; Circle penuh/yang sudah diikuti tidak disarankan.
