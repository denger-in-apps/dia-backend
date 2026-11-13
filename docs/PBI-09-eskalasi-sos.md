# PBI-09 Eskalasi SOS & Pengelolaan Jadwal Jaga

**Description**

Sebagai mahasiswa, saya ingin SOS tereskalasi otomatis bila tidak direspons; sebagai dosen admin, saya ingin mengatur eskalasi serta akun dan jadwal jaga psikolog.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA (alternatif 3.a–3.b); Bab 4.3 ERD: `LOG_SOS`, `KONTAK_DARURAT`, `JADWAL_JAGA`; FR: FR-ADM-05, FR-ADM-02.

Catatan: judul FR-ADM-02 menyebut "petugas", tetapi deskripsinya hanya psikolog; diasumsikan hanya psikolog.

| Subtask | Jira | Bagian |
|---|---|---|
| [BE] Timer eskalasi 3 menit (Redis) | SCRUM-234 | [§1](#1-timer-eskalasi-scrum-234) |
| [BE] Integrasi SMS Gateway ke kontak darurat dan hotline 119 ext. 8 | SCRUM-235 | [§2](#2-sms-gateway--hotline-scrum-235) |
| [FE][BE] Konfigurasi eskalasi SOS oleh dosen admin (FR-ADM-05) | SCRUM-236 | [§3](#3-konfigurasi-eskalasi-oleh-dosen-admin-scrum-236) |
| [FE][BE] Kelola akun psikolog dan jadwal jaga (FR-ADM-02) | SCRUM-237 | [§4](#4-kelola-akun-psikolog--jadwal-jaga-scrum-237) |

---

## 1. Timer eskalasi (SCRUM-234)

### Alur

```
SOS dibuat (BARU) ──► BullMQ delayed job `eskalasi-<id_sos>` (durasi_eskalasi_detik, default 180 dtk)
                 └─► notifikasi psikolog jaga (PBI-07)
                       └─ tidak ada psikolog sama sekali, atau tidak ada yang jaga
                          dan eskalasi_segera_jika_tidak_ada_psikolog = true → eskalasi seketika
timer habis ──► UPDATE log_sos SET status='ESKALASI' WHERE id_sos=$1 AND status='BARU'
                 ├─ 0 baris (sudah diambil / dibatalkan / sudah tereskalasi) → selesai, tanpa efek
                 └─ 1 baris → siaran `sos:diperbarui` + `sos:eskalasi` ke SEMUA psikolog aktif
```

### Keandalan

| Risiko | Penanganan |
|---|---|
| API restart sebelum 3 menit | Timer disimpan di Redis (BullMQ delayed job), dijalankan worker instance mana pun |
| Redis mati saat SOS dibuat | Penjadwalan gagal cepat (≤ 2 dtk, `enableOfflineQueue: false`) tanpa menunda respons mahasiswa; **sweeper DB** setiap 30 dtk mengeskalasi SOS `BARU` yang melewati durasi + 15 dtk |
| Eskalasi ganda (timer + sweeper + multi-instance) | Eskalasi adalah UPDATE bersyarat `status = 'BARU'` — hanya satu pemanggil yang berhasil |
| Job gagal (DB sementara down) | Diulang 5× dengan backoff eksponensial; sweeper tetap menjadi cadangan |
| Event error Redis | Listener dipasang (proses tidak jatuh); peringatan berulang dibatasi 1×/menit |
| Proses mati / DB putus **setelah** status `ESKALASI` tetapi sebelum SMS terkirim | Pola outbox: `UPDATE` eskalasi sekaligus mengklaim tindakan (`tindakan_klaim_at`); `tindakan_eskalasi_at` diisi setelah SMS/hotline selesai. Sweeper mengklaim ulang tindakan yang belum selesai setelah 120 dtk (`FOR UPDATE SKIP LOCKED`), maks. 5 percobaan, **selama SOS masih `ESKALASI`** (sudah diambil psikolog → tidak diulang). Habis percobaan → log error untuk penanganan manual |

`ESKALASI_WORKER_AKTIF=false` mematikan worker pada instance tertentu (sweeper tetap aktif).

### Keselarasan dengan validasi tombol Genta (PBI-05)

- Eskalasi hanya untuk SOS yang sudah melewati konfirmasi dua langkah; SOS yang
  **dibatalkan mahasiswa** (salah tekan) berstatus `SELESAI` sehingga timer berakhir tanpa efek.
- SOS bertanda `perlu_verifikasi` **tetap dieskalasi**. Kecurigaan penyalahgunaan hanya
  menurunkan prioritas, tidak pernah menghentikan bantuan.
- Dedupe SOS aktif (indeks unik parsial) membuat satu mahasiswa hanya punya satu timer berjalan.

### Sisi mahasiswa

`GET /api/v1/genta/sos/aktif` kini memuat `waktu_eskalasi` dan `eskalasi_119`;
FE menampilkan info hotline secara menonjol ketika status `ESKALASI`.

### Sisi psikolog

Event Socket.IO `sos:eskalasi` (namespace `/psikolog`) dikirim ke semua psikolog
aktif — bukan hanya yang jaga — dan disimpan sebagai notifikasi in-app.
Kasus `ESKALASI` tetap ada di antrean dashboard dan dapat diambil (PBI-08).

### Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/eskalasi
```

Manual: buat SOS, jangan ambil, tunggu `durasi_eskalasi_detik` → `GET /genta/sos/aktif`
menunjukkan `status_penanganan: "ESKALASI"`. Untuk uji cepat, ubah durasi menjadi 30 detik
melalui konfigurasi admin (SCRUM-236) atau langsung di tabel `konfigurasi_sos`.

---

## 2. SMS gateway & hotline (SCRUM-235)

Dijalankan oleh pemenang eskalasi atomik §1, lalu diulang sweeper hanya bila belum selesai
(lihat tabel keandalan §1). Retry aman: penerima yang sudah `TERKIRIM` untuk SOS tersebut
dilewati berdasarkan `log_eskalasi.penerima_ref` (`<jenis>:<id>`), idempotency key provider
tetap sama, dan baris `INFO_HOTLINE` hanya dicatat sekali.

### Hotline Healing119.id — 119 ext. 8

119 ext. 8 adalah **jalur telepon**; SMS gateway tidak dapat "memberi tahu" hotline
tersebut (02-backend.md §11). Implementasi mengikuti rekomendasi dokumen:

- `log_sos.eskalasi_119 = true` dan baris `log_eskalasi` kanal `INFO_HOTLINE`
  (`jenis_penerima = HOTLINE`) bila `konfigurasi_sos.hotline_aktif`;
- label hotline dicantumkan di setiap SMS eskalasi;
- mahasiswa melihat `eskalasi_119` di `GET /genta/sos/aktif` dan FE menampilkan
  tombol `tel:` hotline secara menonjol.

Integrasi langsung ke layanan hotline memerlukan perjanjian/API resmi dari pengelolanya.

### Penerima SMS

| Penerima | Kapan dikabari |
|---|---|
| Penerima eskalasi kampus (`penerima_eskalasi`, aktif) | Selalu |
| Kontak darurat mahasiswa (`kontak_darurat`) | Sesuai kebijakan di bawah |

Kebijakan kontak darurat (selaras dengan validasi tombol Genta, PBI-05), agar SOS palsu
tidak dapat dipakai untuk mengganggu keluarga tanpa mengorbankan keselamatan:

| Kondisi | Kontak darurat |
|---|---|
| Admin menonaktifkan (`kontak_darurat_aktif = false`) | Dilewati (`DINONAKTIFKAN_ADMIN`) |
| SOS `perlu_verifikasi` dan situasi **tidak** kritis | Dilewati (`PERLU_VERIFIKASI`), kecuali admin mengaktifkan `kontak_darurat_untuk_perlu_verifikasi` |
| Situasi kritis (`INGIN_MENYAKITI_DIRI`, `DALAM_BAHAYA`) | Dikabari walaupun `perlu_verifikasi` |
| ≥ `maks_eskalasi_kontak_per_hari` (default 3) eskalasi lain yang sudah mengabari kontak darurat dalam 24 jam | Dilewati (`BATAS_HARIAN`) |

Penerima eskalasi kampus tetap selalu dikabari pada semua kondisi di atas. Kebijakan ini
diatur Dosen Admin (§3).

### Isi SMS

- Kampus: `[Denger.in] DARURAT: SOS dari <nama> belum direspons psikolog. Prioritas <P>. Segera tindak lanjuti. Ref <8 karakter id>. Bantuan krisis: <hotline>.`
- Kontak darurat: `[Denger.in] <nama> menekan tombol darurat dan belum terhubung dengan psikolog. Mohon segera hubungi <nama>. Bantuan krisis: <hotline>.`

Nama (`nama_tampilan` bila ada) disertakan agar penerima dapat menjangkau mahasiswa.
SMS **tidak** memuat situasi, koordinat, atau isi keluhan.

### Pengiriman & log

- Antarmuka `SmsProvider.kirim(nomor, teks, idempotencyKey)`; `SMS_PROVIDER=console`
  (simulasi, default development) atau `http`. Produksi wajib `http`.
- Adapter HTTP generik: `POST SMS_GATEWAY_URL` dengan `Authorization: Bearer SMS_GATEWAY_TOKEN`,
  body `{ to, message, idempotency_key, sender? }`, header `Idempotency-Key`, timeout 5 dtk,
  HTTPS wajib di produksi. Sesuaikan dengan dokumentasi provider yang dipilih.
- Retry maks. 3 percobaan per penerima dengan backoff eksponensial (`SMS_RETRY_BACKOFF_MS`,
  default 1000 → 1 dtk, 3 dtk); penerima dikirim paralel.
- Setiap percobaan dicatat di `log_eskalasi` (`status`, `percobaan_ke`, `provider_message_id`,
  `error`). Nomor hanya disimpan tersamar (`0812*****890`); deret digit di pesan error juga
  disamarkan. Isi pesan tidak dicatat.
- Nomor penerima kampus didekripsi dengan AAD `penerima_eskalasi:no_telepon_enc:<id>`,
  kontak darurat dengan `kontak_darurat:no_telepon_enc:<id_kontak>`.

Migrasi `1793700400000-EskalasiSms` menambah `log_eskalasi.jenis_penerima`; migrasi
`1793800300000-EskalasiTindakanTahanGagal` menambah kolom outbox `log_sos.tindakan_eskalasi_at`,
`tindakan_klaim_at`, `tindakan_percobaan` dan `log_eskalasi.penerima_ref` (eskalasi lama
ditandai sudah ditindak agar tidak memicu SMS susulan setelah deploy).

### Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/eskalasi
```

Dengan `SMS_PROVIDER=console`, log API menampilkan baris `[SIMULASI] SMS ke 0812*****890`
untuk setiap penerima saat SOS tereskalasi.

---

## 3. Konfigurasi eskalasi oleh Dosen Admin (SCRUM-236)

Konfigurasi runtime disimpan di baris tunggal `konfigurasi_sos` (bukan env) sehingga
dapat diubah tanpa deploy (02-backend.md §4). Semua endpoint: prefix `/api/v1`,
Bearer token, hanya role `DOSEN_ADMIN` (role lain `403`).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/konfigurasi-sos` | Konfigurasi saat ini (+ `diubah_oleh`, `updated_at`) |
| PUT | `/admin/konfigurasi-sos` | Ubah konfigurasi; **hanya field yang dikirim yang berubah** |
| GET | `/admin/penerima-eskalasi` | Daftar penerima SMS kampus (nomor tersamar) |
| POST | `/admin/penerima-eskalasi` | `{ nama, no_telepon, aktif? }` (maks. 20) |
| PATCH | `/admin/penerima-eskalasi/:id` | Ubah nama/nomor/aktif |
| DELETE | `/admin/penerima-eskalasi/:id` | Hapus penerima |

### Field konfigurasi

| Field | Default | Rentang | Dipakai oleh |
|---|---|---|---|
| `durasi_eskalasi_detik` | 180 | 30–1800 | Timer §1 (berlaku untuk SOS baru) |
| `eskalasi_segera_jika_tidak_ada_psikolog` | `true` | — | Eskalasi seketika bila tidak ada psikolog jaga |
| `hotline_label` | `Healing119.id — 119 ext. 8` | 3–100 karakter | Respons mahasiswa & teks SMS |
| `hotline_aktif` | `true` | — | Info hotline & `eskalasi_119` |
| `kontak_darurat_aktif` | `true` | — | SMS kontak darurat (§2) |
| `kontak_darurat_untuk_perlu_verifikasi` | `false` | — | Kabari kontak darurat untuk SOS `perlu_verifikasi` non-kritis |
| `maks_eskalasi_kontak_per_hari` | 3 | 1–10 | Batas SMS kontak darurat per mahasiswa / 24 jam |
| `sos_maks_per_jam` | 5 | **1**–60 | Batas SOS baru per akun per jam (PBI-05) |
| `sos_ambang_iseng_30_hari` | 2 | 1–100 | Laporan tidak valid → `perlu_verifikasi` (PBI-05) |
| `sos_ambang_batal_24_jam` | 3 | 1–100 | Pembatalan → `perlu_verifikasi` (PBI-05) |

Rentang divalidasi di API dan ditegakkan ulang dengan `CHECK` di database. Batas bawah
`sos_maks_per_jam = 1` mencegah konfigurasi yang mematikan tombol SOS. Ambang anti-iseng
PBI-05 sebelumnya berupa env (`SOS_MAKS_PER_JAM`, dst.) dan kini dipindah ke sini;
`SOS_KONFIRMASI_TTL_DETIK` dan `SOS_JEDA_MINIMAL_MS` tetap env karena bersifat teknis.

Migrasi `1793800200000-PerbaikiLabelHotline` memperbaiki default `hotline_label` dari
`0001_init.sql` yang tersimpan rusak (`â€”`, UTF-8 ter-encode dua kali). Baris yang masih
bernilai rusak diperbaiki; label yang sudah diubah admin tidak disentuh.

Setiap perubahan dicatat `KONFIGURASI_SOS_UBAH` di audit log beserta nilai sebelum/sesudah
field yang berubah, dan `diubah_oleh` diisi admin pengubah.

### Penerima eskalasi

Nomor divalidasi (8–15 digit, boleh `+`, spasi/tanda hubung dibuang), dienkripsi dengan AAD
`penerima_eskalasi:no_telepon_enc:<id>`, dan API hanya mengembalikan `no_telepon_masked`.
Aksi dicatat `PENERIMA_ESKALASI_BUAT` / `_UBAH` / `_HAPUS`.

Migrasi `1793700500000-KonfigurasiEskalasi` menambah kolom kebijakan & ambang serta trigger
`updated_at` pada `konfigurasi_sos`.

### Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/eskalasi/admin-eskalasi.spec.ts
```

Manual (token dosen admin):

```powershell
curl.exe -k -i -X PUT https://localhost:18443/api/v1/admin/konfigurasi-sos -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"durasi_eskalasi_detik":30}'
curl.exe -k -i -X POST https://localhost:18443/api/v1/admin/penerima-eskalasi -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"nama":"Satgas Kampus","no_telepon":"081234567890"}'
```

---

## 4. Kelola akun psikolog & jadwal jaga (SCRUM-237)

Prefix `/api/v1`, Bearer token. Endpoint `/admin/*` hanya `DOSEN_ADMIN`.

### Akun psikolog

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/psikolog?status=&q=` | Daftar; filter status (`MENUNGGU_VERIFIKASI`/`AKTIF`/`NONAKTIF`) dan cari nama/email |
| GET | `/admin/psikolog/:id` | Detail (`mfa_aktif`, `status_jaga`, `kasus_aktif`, …) |
| POST | `/admin/psikolog` | `{ nama, email }` → akun `MENUNGGU_VERIFIKASI` + `password_sementara` (sekali tampil) |
| PATCH | `/admin/psikolog/:id` | Ubah `nama`/`email` (`409 EMAIL_SUDAH_TERDAFTAR` bila dipakai) |
| POST | `/admin/psikolog/:id/aktifkan` | `AKTIF`; mengisi `diverifikasi_oleh`/`diverifikasi_at` (use case Login Akun Staf alt 4.a) |
| POST | `/admin/psikolog/:id/nonaktifkan` | `NONAKTIF` (lihat di bawah) |
| POST | `/admin/psikolog/:id/reset-password` | `password_sementara` baru; semua sesi dicabut |

Password sementara 24 karakter acak, di-hash argon2id, dan dikirim dengan
`Cache-Control: no-store`; serahkan ke psikolog lewat kanal aman. Akun ditandai
`wajib_ganti_password` (terlihat di `GET /auth/me`) sampai psikolog menggantinya lewat
`POST /auth/staff/password` `{ password_lama, password_baru }` (min. 12 karakter, berlaku
juga untuk dosen admin; semua sesi dicabut setelah berhasil, maks. 5 percobaan/menit).

**Menonaktifkan psikolog aman bagi mahasiswa:** dalam satu transaksi,

1. kasus SOS yang sedang dipegang (`DIAMBIL`/`DITANGANI`) dikembalikan ke antrean sebagai
   **`ESKALASI`** (tanpa penangan) dan setelah commit disiarkan `sos:diperbarui` + `sos:eskalasi`
   ke semua psikolog aktif (`sumber: PENANGAN_NONAKTIF`), sehingga tidak ada mahasiswa yang
   tertinggal tanpa penangan. **Tidak** ada SMS eskalasi untuk kasus ini (ditandai
   `tindakan_eskalasi_at`): kasusnya sudah sempat ditangani, sehingga SMS "belum direspons"
   ke kampus/keluarga akan menyesatkan;
2. jadwal jaga yang sedang berjalan/mendatang dihapus dan `status_jaga = false`;
3. semua refresh token dicabut; access token langsung ditolak guard (status akun dicek per
   request) dan koneksi Socket.IO psikolog diputus.

Respons memuat `kasus_dikembalikan` dan `jadwal_dihapus`. Semua aksi dicatat di audit log
(`AKUN_PSIKOLOG_BUAT/UBAH/AKTIFKAN/NONAKTIFKAN/RESET_PASSWORD`).

### Jadwal jaga

| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | `/admin/jadwal-jaga?dari=&sampai=&id_psikolog=` | Admin | Default 14 hari dari hari ini; maks. 62 hari |
| POST | `/admin/jadwal-jaga` | Admin | `{ id_psikolog, tanggal: 'YYYY-MM-DD', jam_mulai: 'HH:MM', jam_selesai: 'HH:MM' }` |
| PATCH | `/admin/jadwal-jaga/:id` | Admin | Ubah sebagian; divalidasi ulang dengan nilai gabungan |
| DELETE | `/admin/jadwal-jaga/:id` | Admin | Hapus |
| GET | `/psikolog/jadwal-jaga?dari=&sampai=` | Psikolog | Jadwal milik sendiri |

Aturan:

- Jam dalam zona `JADWAL_ZONA_WAKTU` (default `Asia/Jakarta`); `jam_selesai > jam_mulai`,
  `jam_selesai` boleh `24:00`. Shift lewat tengah malam dibuat dua entri
  (mis. `22:00–24:00` dan `00:00–06:00` hari berikutnya).
- Hanya psikolog `AKTIF` (`422 PSIKOLOG_TIDAK_AKTIF`); jadwal yang sudah berakhir tidak dapat
  dibuat/diubah (`422 JADWAL_SUDAH_LEWAT`).
- Tidak boleh tumpang tindih untuk psikolog yang sama: dijamin exclusion constraint
  `jadwal_jaga_tidak_bentrok` (`409 JADWAL_BENTROK`), aman terhadap request bersamaan.
- `id_dosen` diisi admin yang menetapkan; aksi dicatat `JADWAL_JAGA_BUAT/UBAH/HAPUS`.

### Sinkronisasi `status_jaga`

Job tiap menit menyetel `psikolog.status_jaga` dari jadwal yang sedang berjalan (hanya baris
yang berubah ditulis; psikolog non-aktif selalu `false`). Penentuan penerima notifikasi SOS
(PBI-07) tetap membaca `jadwal_jaga` langsung (04-database.md §4.f), sehingga perubahan jadwal
berlaku seketika tanpa menunggu sinkronisasi.

Migrasi `1793700600000-KelolaPsikologJadwal` menambah `wajib_ganti_password` (psikolog &
dosen admin) dan exclusion constraint jadwal.

### Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/admin-staf
```

Catatan: di produksi `STAFF_MFA_REQUIRED` default `true`, sehingga psikolog baru belum dapat
login sampai alur pendaftaran MFA tersedia (lihat PBI-01).

---

## Kriteria penerimaan PBI-09

- [x] SOS yang tidak diambil dalam `durasi_eskalasi_detik` (default 3 menit) tereskalasi otomatis, tahan restart dan Redis mati; SMS eskalasi tidak hilang bila proses mati di tengah.
- [x] SOS tanpa psikolog jaga dapat tereskalasi seketika sesuai konfigurasi.
- [x] Eskalasi mengirim SMS ke penerima kampus dan kontak darurat (dengan perlindungan anti-penyalahgunaan) serta menandai hotline 119 ext. 8.
- [x] Dosen admin dapat mengatur durasi, hotline, kebijakan kontak darurat, ambang anti-iseng, dan penerima eskalasi; perubahan diaudit.
- [x] Dosen admin dapat mengelola akun psikolog (buat, verifikasi/aktifkan, nonaktifkan, reset password) dan jadwal jaga tanpa bentrok.
- [x] Menonaktifkan psikolog tidak meninggalkan SOS tanpa penangan.
