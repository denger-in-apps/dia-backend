# PBI-17 Circle: telusuri, bergabung, dan persetujuan pembentukan — SCRUM-263, SCRUM-264

**Description**

Sebagai mahasiswa, saya ingin bergabung ke Circle sesuai minat agar mendapat dukungan sebaya.

**Referensi proposal:** Tabel 5.1 Sprint 4 (Pendampingan & Dukungan Mahasiswa); Bab 4.1 Use Case: Circle; Bab 4.3 ERD: `CIRCLE`, `KEANGGOTAAN_CIRCLE`, `DOSEN_ADMIN`; FR: FR-MHS-06, FR-ADM-07.

Catatan backlog: persetujuan pembentukan Circle (bagian FR-ADM-07) di proposal ada di PBI-20
Sprint 5; ditarik ke sini karena Circle tidak bisa berjalan tanpanya.

```
mahasiswa: POST /circles ─► DIAJUKAN ──admin setujui + pendamping──► AKTIF ──admin tutup──► DITUTUP
                                └──admin tolak + alasan──► DITOLAK
mahasiswa: GET /circles ─► POST /circles/:id/gabung (kuota 5–8) ─► ruang interaksi /circles/:id/pesan
```

## 1. Mahasiswa (SCRUM-263)

Prefix `/api/v1`, Bearer token, role `MAHASISWA` (kecuali `GET /kategori-minat`: semua role).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/kategori-minat` | Kategori minat aktif `[{ id, nama }]` |
| GET | `/circles?kategori=&q=&limit=` | Circle `AKTIF`: kuota, `jumlah_anggota`, `sisa_kuota`, pendamping, `sudah_bergabung` |
| GET | `/circles/saya` | `{ diikuti[] (+ alias & status anonim saya), pengajuan[] (DIAJUKAN/DITOLAK + alasan) }` |
| GET | `/circles/:id` | Detail; daftar `anggota` (alias/nama) hanya untuk anggota |
| POST | `/circles` | Ajukan pembentukan `{ nama_circle, deskripsi?, id_kategori, kuota? (5–8, default 8) }` → `DIAJUKAN` |
| POST | `/circles/:id/gabung` | `201` baru bergabung · `200` sudah anggota (idempoten) |
| POST | `/circles/:id/keluar` | `204`; pesan anggota tersebut ikut terhapus |
| PATCH | `/circles/:id/keanggotaan` | `{ status_anonim }` — `false` menampilkan nama tampilan ke sesama anggota |
| GET · POST | `/circles/:id/pesan` | Ruang interaksi anggota (`?sebelum=<id_pesan>&limit=` untuk paginasi mundur) · `{ isi }` (1–2000) |

| Aturan | Respons |
|---|---|
| Kuota penuh (gabung bersamaan dijaga `SELECT … FOR UPDATE` pada baris `circle`, 04-database.md §4.g) | `409 CIRCLE_PENUH` |
| Circle bukan `AKTIF` | `409 CIRCLE_TIDAK_AKTIF` |
| Sudah mengikuti `CIRCLE_MAKS_PER_MAHASISWA` (5) Circle aktif | `422 BATAS_KEANGGOTAAN` |
| Pengajuan `DIAJUKAN` ≥ `CIRCLE_MAKS_PENGAJUAN` (2) | `422 BATAS_PENGAJUAN` |
| Kategori tidak aktif | `422 KATEGORI_TIDAK_VALID` |
| Bukan anggota (keluar, pesan, ubah anonim) | `403 BUKAN_ANGGOTA` |
| Lebih dari `CIRCLE_MAKS_PESAN_PER_MENIT` (20) pesan | `429 PESAN_TERLALU_CEPAT` |

**Anonimitas (NFR-04):** keanggotaan anonim secara default dengan alias acak `Anggota-XXXX` yang
unik per Circle (constraint `keanggotaan_circle_alias_unik`, migrasi `1793900200000-CircleKeanggotaan`).
Orang luar tidak dapat melihat siapa anggota sebuah Circle; Circle yang belum aktif hanya terlihat
oleh pengajunya. Pesan yang disembunyikan moderator tampil ke anggota sebagai
`isi: null, disembunyikan: true` beserta `alasan_moderasi` (moderasi: PBI-18).

Catatan: `circle_pesan.isi` disimpan polos sesuai skema (ruang sebaya, bukan percakapan klinis);
ruang interaksi saat ini berbasis polling REST, belum realtime.

## 2. Dosen Admin (SCRUM-264)

Prefix `/api/v1`, Bearer token, hanya role `DOSEN_ADMIN`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/circles?status=` | Semua Circle (pengajuan dulu) + `jumlah_anggota`, `diajukan_mahasiswa` |
| POST | `/admin/circles` | Buat Circle resmi langsung `AKTIF` `{ nama_circle, deskripsi?, id_kategori, kuota?, id_psikolog }` |
| GET · PATCH | `/admin/circles/:id` | Detail · ubah sebagian `{ nama_circle?, deskripsi?, id_kategori?, kuota?, id_psikolog? }` |
| POST | `/admin/circles/:id/setujui` | `{ id_psikolog }` — `DIAJUKAN` → `AKTIF`; pengaju dikabari `CIRCLE_DISETUJUI` |
| POST | `/admin/circles/:id/tolak` | `{ alasan }` (3–500) — `DIAJUKAN` → `DITOLAK`; alasan terlihat pengaju, dikabari `CIRCLE_DITOLAK` |
| POST | `/admin/circles/:id/tutup` | `AKTIF`/`DIAJUKAN` → `DITUTUP` (anggota tidak dapat menulis/bergabung lagi) |
| GET · POST | `/admin/kategori-minat` | Daftar (termasuk nonaktif + jumlah Circle aktif) · `{ nama }` |
| PATCH | `/admin/kategori-minat/:id` | `{ nama?, aktif? }` — nonaktif = tidak bisa dipilih untuk Circle baru |

| Aturan | Respons |
|---|---|
| Pendamping bukan psikolog `AKTIF` (CHECK `circle_aktif_butuh_pendamping` juga menjamin pendamping ada) | `422 PSIKOLOG_TIDAK_AKTIF` |
| Setujui/tolak bukan `DIAJUKAN`, tutup bukan `AKTIF`/`DIAJUKAN` | `409 STATUS_CIRCLE_TIDAK_SESUAI` |
| Kuota baru < jumlah anggota | `409 KUOTA_DI_BAWAH_ANGGOTA` |
| Ubah Circle `DITOLAK`/`DITUTUP` | `409 CIRCLE_TIDAK_DAPAT_DIUBAH` |
| Ganti pendamping sebelum disetujui | `422 PENDAMPING_LEWAT_PERSETUJUAN` |
| Nama kategori dipakai | `409 KATEGORI_SUDAH_ADA` |

**Privasi:** admin tidak melihat identitas pengaju maupun anggota, dan tidak dapat membaca pesan
(04-database.md §4.e) — hanya metadata dan jumlah anggota. Audit: `CIRCLE_SETUJUI`, `CIRCLE_TOLAK`,
`CIRCLE_BUAT`, `CIRCLE_UBAH`, `CIRCLE_TUTUP`, `KATEGORI_MINAT_BUAT`, `KATEGORI_MINAT_UBAH`.

Kategori minat belum di-seed (daftar final ditetapkan PO + psikolog, 04-database.md §7): admin
membuatnya sebelum Circle dapat diajukan. Endpoint `/admin/kategori-minat` kini berada di modul
`master-data` (PBI-20 §2, termasuk hapus kategori yang belum dipakai); path tidak berubah.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/circle
```

## Kriteria penerimaan PBI-17

- [x] Mahasiswa dapat menelusuri Circle aktif per kategori minat dan melihat sisa kuota.
- [x] Mahasiswa dapat bergabung (anonim default) tanpa melampaui kuota, termasuk saat bersamaan, dan dapat keluar.
- [x] Mahasiswa dapat mengajukan pembentukan Circle untuk disetujui Dosen Admin.
- [x] Anggota dapat berinteraksi di ruang Circle; orang luar tidak dapat melihat anggota atau pesan.
- [x] Dosen Admin dapat menyetujui (dengan pendamping) atau menolak (dengan alasan) pengajuan, serta membuat, mengubah, dan menutup Circle; pengaju dikabari.
- [x] Dosen Admin mengelola kategori minat; semua aksi diaudit tanpa membuka identitas anggota.
