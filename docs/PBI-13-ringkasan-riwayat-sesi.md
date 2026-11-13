# PBI-13 Ringkasan dan Riwayat Sesi — SCRUM-251

**Description**

Sebagai psikolog, saya ingin mencatat ringkasan dan melihat riwayat sesi agar pendampingan berkesinambungan.

**Referensi proposal:** Tabel 5.1 Sprint 3 (Layanan Konseling); Bab 4.1 Use Case: Booking Konseling (pascakondisi); Bab 4.3 ERD: `SESI_KONSELING`; FR: FR-PSI-05, FR-PSI-08.

Catatan backlog: FR-PSI-05 juga mencakup curhat anonim; bagian itu dikerjakan di PBI-16 (Sprint 4).

## 1. Consent pencatatan (mahasiswa)

| Method | Path | Role | Body |
|---|---|---|---|
| POST | `/booking/:id/consent-catatan` | Mahasiswa (sesi milik sendiri) | `{ setuju: boolean }` |

- Dapat diatur selama sesi `DIJADWALKAN`, `BERLANGSUNG`, atau `SELESAI` (selain itu `409 SESI_TIDAK_DAPAT_DIUBAH`).
- `setuju: false` **menghapus ringkasan** yang sudah ada. CHECK DB `sesi_ringkasan_butuh_consent`
  membuat ringkasan tanpa consent mustahil tersimpan, bahkan bila aplikasi bermasalah.
- Perubahan dicatat `SESI_CONSENT_BERI` / `SESI_CONSENT_TARIK`. Status consent terlihat di
  `GET /booking/:id` dan `GET /psikolog/sesi/:id` (`consent_catatan`).

## 2. Ringkasan sesi (psikolog)

| Method | Path | Keterangan |
|---|---|---|
| PUT | `/psikolog/sesi/:id/ringkasan` | `{ ringkasan }` (1–5000 karakter, boleh multi-baris); buat/perbarui |
| GET | `/psikolog/sesi/:id/ringkasan` | Baca ringkasan (terdekripsi) |

Hanya psikolog sesi tersebut (lainnya `404`). Respons `Cache-Control: no-store`.

| Kondisi | Respons |
|---|---|
| Mahasiswa belum/menarik consent | `403 CONSENT_BELUM_ADA` (use case alt 4.a, ringkasan tidak disimpan) |
| Sesi belum `BERLANGSUNG`/`SELESAI` | `409 SESI_BELUM_BERLANGSUNG` |
| Belum ada ringkasan (GET) | `404 RINGKASAN_BELUM_ADA` |

- Disimpan terenkripsi AES-256-GCM, AAD `sesi_konseling:catatan_ringkasan_enc:<id_sesi>`.
- Menulis mengunci baris sesi (`FOR UPDATE`), sehingga penarikan consent yang bersamaan
  tidak tertimpa.
- Audit: `SESI_RINGKASAN_CREATE`, `SESI_RINGKASAN_UPDATE`, `SESI_RINGKASAN_READ` (02-backend.md §10).

## 3. Riwayat sesi (FR-PSI-08)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/psikolog/riwayat` | Mahasiswa yang pernah ditangani: `[{ id, nama, jumlah_sesi, sesi_terakhir }]` |
| GET | `/psikolog/riwayat?mahasiswa=<id>` | Riwayat sesi mahasiswa tersebut |

"Pernah ditangani" = punya sesi `BERLANGSUNG` atau `SELESAI` dengan psikolog ini. Selain itu
`403 BUKAN_MAHASISWA_DAMPINGAN`; penolakan juga dicatat (`RIWAYAT_SESI_READ`, hasil `DITOLAK`).

Isi riwayat:

| Data | Sesi milik psikolog ini | Sesi dengan psikolog lain |
|---|---|---|
| Waktu, tipe, status, nama psikolog | ✓ | ✓ |
| Ringkasan | ✓ bila `consent_catatan` | ✗ (selalu `null`) |

> **Keputusan privasi (konfirmasi PO + psikolog):** consent diberikan per sesi kepada psikolog
> sesi tersebut, sehingga ringkasan psikolog lain tidak dibagikan. Bila kampus ingin catatan
> lintas-psikolog (mis. rujukan), tambahkan consent "bagikan ke psikolog lain" secara terpisah.

Riwayat sisi mahasiswa tersedia di `GET /booking?cakupan=riwayat` (PBI-10).

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/sesi
```

Manual: mahasiswa `POST /booking/<id>/consent-catatan {"setuju":true}` → psikolog memulai sesi
(PBI-11) → `PUT /psikolog/sesi/<id>/ringkasan`. Mahasiswa menarik consent → `GET` ringkasan
menghasilkan `403 CONSENT_BELUM_ADA` dan kolom `catatan_ringkasan_enc` menjadi `NULL`.

## Kriteria penerimaan PBI-13

- [x] Mahasiswa dapat memberi atau menarik consent pencatatan ringkasan per sesi.
- [x] Psikolog dapat mencatat dan memperbarui ringkasan hanya dengan consent; tersimpan terenkripsi dan diaudit.
- [x] Psikolog dapat melihat riwayat sesi mahasiswa yang pernah ditanganinya, tanpa membuka ringkasan psikolog lain.
- [x] Akses ringkasan dan riwayat tercatat di audit log.
