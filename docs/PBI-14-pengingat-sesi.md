# PBI-14 Pengingat Sesi Konseling — SCRUM-253

**Description**

Sebagai mahasiswa, saya ingin menerima pengingat sesi agar tidak terlewat.

**Referensi proposal:** Tabel 5.1 Sprint 3 (Layanan Konseling); Bab 4.1 Use Case: Booking Konseling; Bab 4.3 ERD: `SESI_KONSELING`; FR: FR-MHS-11.

## Alur

```
booking / ubah jadwal / batal (PBI-10, PBI-12)
   └─ dalam transaksi yang sama: pengingat_sesi diatur ulang
        DIJADWALKAN → baris (id_sesi, 1440) & (id_sesi, 60) yang masih di masa depan
        DIBATALKAN  → semua baris dihapus

worker tiap 60 dtk (semua instance)
   1. tutup pengingat sesi yang batal/dimulai/lewat (status GAGAL, error SESI_TIDAK_RELEVAN)
   2. klaim ≤ 50 baris jatuh tempo: FOR UPDATE SKIP LOCKED + lease 5 menit (coba_lagi_at)
   3. notifikasi in-app PENGINGAT_SESI → mahasiswa & psikolog (tepat sekali, ditandai inapp_at)
   4. email ke mahasiswa → TERKIRIM, atau retry 60 dtk × 4^(n-1), maks. 3 percobaan → GAGAL
```

Offset default H-24 jam dan H-1 jam (02-backend.md §9.4) diatur lewat `PENGINGAT_OFFSET_MENIT`
(daftar dipisah koma, 5–10080 menit). Offset yang sudah lewat saat booking dibuat tidak dijadwalkan.
Mahasiswa yang memesan 2 jam sebelum sesi hanya mendapat pengingat H-1 jam.

## Kanal

| Kanal | Penerima | Isi |
|---|---|---|
| In-app (`GET /api/v1/notifikasi`, jenis `PENGINGAT_SESI`) | Mahasiswa & psikolog | `{ id_sesi, waktu_mulai, tipe_sesi, menit_sebelum }` |
| Email | Mahasiswa (`mahasiswa.email` dari SSO) | Nama psikolog, tipe & waktu sesi (zona `JADWAL_ZONA_WAKTU`), ajakan membuka aplikasi |

Isi pengingat **tidak** memuat keluhan atau topik sesi (02-backend.md §9.4). Alamat email
disamarkan (`bu***@kampus.ac.id`) di log dan kolom `error`. Akun yang sudah dihapus tidak dikirimi
email.

## Keandalan

| Risiko | Penanganan |
|---|---|
| Jadwal berubah setelah pengingat dibuat | Diatur ulang di transaksi ubah/batal; worker juga memeriksa status & waktu sesi saat kirim |
| Banyak instance API | Klaim `FOR UPDATE SKIP LOCKED`, sehingga satu baris hanya diproses satu instance |
| Proses mati di tengah kirim | Lease `coba_lagi_at` kedaluwarsa setelah 5 menit, lalu baris diklaim ulang. In-app tidak dobel karena `inapp_at`, email memakai `Idempotency-Key` `pengingat:<id_sesi>:<offset>` |
| Email gateway gagal (use case alt 2.a) | Retry eksponensial maks. `PENGINGAT_MAKS_PERCOBAAN` (3), lalu `GAGAL` + `error` |
| Worker ingin dimatikan di instance tertentu | `PENGINGAT_WORKER_AKTIF=false` |

## Konfigurasi

| Env | Default | Keterangan |
|---|---|---|
| `PENGINGAT_OFFSET_MENIT` | `1440,60` | Offset menit sebelum sesi |
| `PENGINGAT_MAKS_PERCOBAAN` | `3` | Percobaan email maksimal |
| `PENGINGAT_RETRY_DASAR_DETIK` | `60` | Jeda dasar retry |
| `PENGINGAT_WORKER_AKTIF` | `true` | Worker per instance |
| `EMAIL_PROVIDER` | `console` | `console` (simulasi, log) atau `http`; **produksi wajib `http`** |
| `EMAIL_GATEWAY_URL` / `EMAIL_GATEWAY_TOKEN` / `EMAIL_PENGIRIM` | — | Adapter REST generik: `POST` JSON `{ from, to, subject, text }`, `Authorization: Bearer`, header `Idempotency-Key`, timeout 5 dtk, HTTPS wajib di produksi. Sesuaikan dengan provider terpilih |

Migrasi `1793800100000-PengingatSesi` menambah kolom `coba_lagi_at`, `inapp_at`, `error`,
CHECK offset, dan indeks parsial baris `ANTRE`.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/notifikasi src/modules/booking
```

Manual: atur `PENGINGAT_OFFSET_MENIT=1440,60,90` (atau booking slot ≈ 1–2 jam ke depan), booking
sesi, lalu tunggu ≤ 1 menit setelah waktu pengingat. Log API menampilkan
`[SIMULASI] Email ke bu***@…` dan `GET /api/v1/notifikasi` (token mahasiswa) memuat
`PENGINGAT_SESI`. Ubah jadwal → baris `pengingat_sesi` mengikuti waktu baru; batalkan → baris hilang.

## Kriteria penerimaan PBI-14

- [x] Mahasiswa menerima pengingat in-app dan email sebelum sesi (default H-24 jam dan H-1 jam).
- [x] Pengingat mengikuti perubahan jadwal dan tidak dikirim untuk sesi yang dibatalkan/sudah dimulai.
- [x] Kegagalan kirim dicoba ulang maks. 3 kali dengan backoff, lalu dicatat gagal.
- [x] Aman dijalankan di banyak instance tanpa pengingat ganda.
- [x] Isi pengingat tidak memuat topik keluhan.
