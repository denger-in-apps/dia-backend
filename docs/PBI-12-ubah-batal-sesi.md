# PBI-12 Perubahan dan Pembatalan Sesi — SCRUM-247

**Description**

Sebagai mahasiswa, saya ingin mengubah atau membatalkan sesi agar fleksibel.

**Referensi proposal:** Tabel 5.1 Sprint 3 (Layanan Konseling); Bab 4.1 Use Case: Booking Konseling (alternatif 5.a–5.d); Bab 4.3 ERD: `SESI_KONSELING`; FR: FR-MHS-05.

Prefix `/api/v1`, Bearer token, hanya role `MAHASISWA`, hanya sesi milik sendiri (sesi orang lain → `404`).

| Method | Path | Body | Keterangan |
|---|---|---|---|
| PATCH | `/booking/:id/jadwal` | `{ waktu_mulai, tipe_sesi? }` | Pindah ke slot lain **psikolog yang sama** (`GET /psikolog/:id/slot`) |
| POST | `/booking/:id/batal` | `{ alasan? }` (1–500 karakter) | Status → `DIBATALKAN`, `alasan_batal` diisi (default `Dibatalkan mahasiswa`) |

Mengganti psikolog = batalkan sesi lalu booking baru (PBI-10), agar psikolog lama dan baru
sama-sama mendapat notifikasi yang benar.

## Aturan

| Kondisi | Ubah jadwal | Batal |
|---|---|---|
| Status bukan `DIJADWALKAN` | `409 SESI_TIDAK_DAPAT_DIUBAH` (`SESI_SUDAH_DIBATALKAN` bila sudah batal) | sama |
| Batas waktu | paling lambat `BOOKING_MIN_SEBELUM_MENIT` (60) sebelum jadwal **lama** | sampai sesi dimulai |
| Batas waktu terlewati | `422 BATAS_WAKTU_TERLEWATI` | `422 BATAS_WAKTU_TERLEWATI` |
| Waktu baru bukan slot sah psikolog | `422 SLOT_TIDAK_VALID` | — |
| Slot baru sudah terisi (alt 5.b) | `409 SESI_BENTROK` + `detail.alternatif` (≤ 5 slot; slot milik sesi ini tidak dianggap terisi) | — |
| Bentrok dengan sesi lain milik sendiri | `409 SESI_BENTROK_MAHASISWA` | — |
| Waktu & tipe sama dengan sekarang | `200` tanpa perubahan (idempoten) | — |

Status dan batas waktu diperiksa ulang di dalam transaksi dengan kunci baris
(`SELECT … FOR UPDATE`), sehingga ubah dan batal yang bersamaan tidak saling menimpa.
Exclusion constraint tetap menjadi jaminan akhir anti-bentrok saat dua mahasiswa
memperebutkan slot yang sama.

Pembatalan setelah sesi dimulai tidak diizinkan dari aplikasi; psikolog menandai sesi
`TIDAK_HADIR` atau `SELESAI` (PBI-11).

## Notifikasi ke psikolog

| Aksi | In-app (`notifikasi.jenis`) | Socket.IO `/psikolog` | Payload |
|---|---|---|---|
| Ubah jadwal | `SESI_DIUBAH` | `booking:diubah` | `{ id_sesi, waktu_mulai, waktu_selesai, tipe_sesi, status_sesi, waktu_mulai_lama }` |
| Batal | `SESI_DIBATALKAN` | `booking:dibatalkan` | `{ id_sesi, waktu_mulai, waktu_selesai, tipe_sesi, status_sesi }` |

Alasan pembatalan tidak dimasukkan ke notifikasi (bisa memuat informasi pribadi); psikolog
melihatnya di `GET /psikolog/sesi/:id`. Pembatalan juga menyiarkan `sesi:status` ke room
`/sesi` dan menutup room tersebut (PBI-11). Status `DIBATALKAN` melepas slot sehingga
dapat dipesan mahasiswa lain.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/booking
```

Manual (token mahasiswa, sesi dari PBI-10):

```powershell
curl.exe -k -i -X PATCH https://localhost:18443/api/v1/booking/<id_sesi>/jadwal -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"waktu_mulai":"2026-12-02T10:00:00+07:00"}'
curl.exe -k -i -X POST https://localhost:18443/api/v1/booking/<id_sesi>/batal -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"alasan":"Ada ujian susulan"}'
```

## Kriteria penerimaan PBI-12

- [x] Mahasiswa dapat mengubah jadwal sesi ke slot lain psikolog yang sama dengan validasi ulang anti-bentrok.
- [x] Slot penuh saat diubah menghasilkan saran slot alternatif.
- [x] Mahasiswa dapat membatalkan sesi sebelum dimulai, dengan alasan opsional.
- [x] Perubahan dan pembatalan dibatasi waktu serta aman terhadap request bersamaan.
- [x] Psikolog dikabari setiap perubahan/pembatalan (in-app + realtime) tanpa membocorkan alasan pribadi.
