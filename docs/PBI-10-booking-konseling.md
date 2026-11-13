# PBI-10 Booking Konseling — SCRUM-242

**Description**

Sebagai mahasiswa, saya ingin memesan sesi konseling dengan psikolog agar mendapat pendampingan.

**Referensi proposal:** Tabel 5.1 Sprint 3 (Layanan Konseling); Bab 4.1 Use Case: Booking Konseling; Bab 4.3 ERD: `SESI_KONSELING`, `JADWAL_JAGA`; FR: FR-MHS-05.

## Alur

```
GET /psikolog                       ─► pilih psikolog (akun AKTIF)
GET /psikolog/:id/slot?tanggal=...  ─► slot kosong pada tanggal itu
POST /booking                       ─► 201 sesi DIJADWALKAN
                                     └► 409 SESI_BENTROK + detail.alternatif[] (slot keburu dipesan)
```

Semua endpoint: prefix `/api/v1`, Bearer token, hanya role `MAHASISWA` (role lain `403`).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/psikolog` | `[{ id, nama, punya_jadwal }]` — psikolog aktif; `punya_jadwal` = ada shift dalam horizon booking |
| GET | `/psikolog/:id/slot?tanggal=YYYY-MM-DD` | Slot kosong `[{ id_psikolog, nama_psikolog, waktu_mulai, waktu_selesai }]` |
| POST | `/booking` | `{ id_psikolog, waktu_mulai, tipe_sesi, keluhan_awal }` |
| GET | `/booking?cakupan=&limit=` | `mendatang` (default, DIJADWALKAN/BERLANGSUNG), `riwayat` (SELESAI/DIBATALKAN/TIDAK_HADIR), `semua` |
| GET | `/booking/:id` | Detail sesi milik sendiri, termasuk `keluhan_awal` terdekripsi (`Cache-Control: no-store`) |

`tipe_sesi`: `CHAT` | `SUARA` | `TATAP_MUKA`. `waktu_mulai` wajib ISO-8601 **dengan zona**
(mis. `2026-12-01T09:00:00+07:00`) dan harus tepat salah satu `waktu_mulai` dari endpoint slot.

## Slot

Slot diturunkan dari `jadwal_jaga` psikolog (ERD menghubungkan `SESI_KONSELING` dengan
`JADWAL_JAGA`; jadwal dikelola Dosen Admin di PBI-09):

- setiap shift dipecah menjadi slot `SESI_DURASI_MENIT` (default 50 mnt) yang dimulai setiap
  `SESI_DURASI_MENIT + SESI_JEDA_MENIT` (default 60 mnt) sejak jam mulai shift, zona `JADWAL_ZONA_WAKTU`;
- slot harus dimulai ≥ `BOOKING_MIN_SEBELUM_MENIT` (60) dari sekarang dan < `BOOKING_HORIZON_HARI` (30) hari;
- slot yang sudah dipegang sesi `DIJADWALKAN`/`BERLANGSUNG` psikolog itu, atau yang bentrok
  dengan sesi aktif mahasiswa sendiri, tidak ditampilkan.

> **Asumsi (konfirmasi PO):** jadwal jaga dipakai bersama untuk SOS (PBI-07) dan booking.
> Bila kampus ingin jam praktik konseling terpisah dari jam jaga SOS, tambahkan tabel
> ketersediaan sendiri; fungsi `cariSlot()` adalah satu-satunya tempat yang perlu diubah.

## Aturan booking

| Aturan | Respons |
|---|---|
| Psikolog tidak ada / tidak `AKTIF` | `404 PSIKOLOG_TIDAK_DITEMUKAN` |
| Waktu bukan slot sah, terlalu dekat, atau di luar horizon | `422 SLOT_TIDAK_VALID` |
| Mahasiswa sudah punya ≥ `BOOKING_MAKS_SESI_AKTIF` (3) sesi mendatang | `422 BATAS_SESI_AKTIF` |
| Slot keburu dipesan mahasiswa lain | `409 SESI_BENTROK`, `detail.alternatif` = ≤ 5 slot terdekat psikolog yang sama; bila kosong, psikolog lain ± 3 jam dari waktu diminta (use case alt 5.b) |
| Mahasiswa sudah punya sesi lain di waktu itu | `409 SESI_BENTROK_MAHASISWA` |

Anti-bentrok bekerja **dua lapis** (02-backend.md §8.4): validasi slot di service, dan
exclusion constraint `sesi_tidak_bentrok_psikolog` / `sesi_tidak_bentrok_mahasiswa`
(SQLSTATE `23P01`) sebagai jaminan akhir saat dua mahasiswa memesan slot yang sama bersamaan.
Batas sesi aktif dihitung di bawah kunci baris `mahasiswa` (`FOR UPDATE`) sehingga request
paralel tidak dapat melewatinya.

## Privasi

- `keluhan_awal` (1–2000 karakter) dienkripsi AES-256-GCM dengan AAD
  `sesi_konseling:keluhan_awal_enc:<id_sesi>`; hanya dikembalikan di hasil booking dan detail.
- Psikolog menerima notifikasi in-app `SESI_BARU` dan event Socket.IO `booking:baru`
  (namespace `/psikolog`) berisi `{ id_sesi, waktu_mulai, waktu_selesai, tipe_sesi, status_sesi }` —
  **tanpa** isi keluhan dan identitas mahasiswa.

Migrasi `1793800000000-BookingKonseling` menambah nilai enum `jenis_notifikasi.SESI_BARU`.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/booking
```

Manual (token mahasiswa; psikolog harus `AKTIF` dan punya jadwal jaga — PBI-09):

```powershell
curl.exe -k -s https://localhost:18443/api/v1/psikolog -H "Authorization: Bearer $token"
curl.exe -k -s "https://localhost:18443/api/v1/psikolog/<id>/slot?tanggal=2026-12-01" -H "Authorization: Bearer $token"
curl.exe -k -i -X POST https://localhost:18443/api/v1/booking -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  --data-raw '{"id_psikolog":"<id>","waktu_mulai":"2026-12-01T09:00:00+07:00","tipe_sesi":"CHAT","keluhan_awal":"Sulit tidur"}'
```

Kirim POST yang sama dari mahasiswa lain → `409 SESI_BENTROK` dengan `detail.alternatif`.

## Kriteria penerimaan PBI-10

- [x] Mahasiswa dapat melihat psikolog aktif dan slot kosongnya per tanggal.
- [x] Mahasiswa dapat memesan sesi (tipe chat/suara/tatap muka) dengan keluhan awal terenkripsi.
- [x] Slot yang sudah dipesan tidak dapat dipesan ulang, termasuk saat request bersamaan; mahasiswa menerima slot alternatif.
- [x] Mahasiswa dapat melihat daftar dan detail sesi miliknya.
- [x] Psikolog dikabari booking baru secara realtime dan in-app tanpa membocorkan isi keluhan.
