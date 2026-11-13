# PBI-11 Pengelolaan Jadwal Sesi Psikolog & Ruang Sesi E2EE — SCRUM-245

**Description**

Sebagai psikolog, saya ingin melihat jadwal dan melaksanakan sesi agar layanan teratur.

**Referensi proposal:** Tabel 5.1 Sprint 3 (Layanan Konseling); Bab 4.1 Use Case: Booking Konseling (langkah 6); Bab 4.3 ERD: `SESI_KONSELING`; FR: FR-PSI-04.

Catatan backlog:
- FR-PSI-04 dan FR-PSI-05 sama-sama menyebut ringkasan sesi; pencatatan ringkasan dikerjakan di PBI-13.
- Enkripsi end-to-end sesi chat (NFR-02) belum punya PBI sendiri di proposal, sehingga dimasukkan ke PBI ini.

## 1. Jadwal & pelaksanaan sesi (psikolog)

Prefix `/api/v1`, Bearer token, hanya role `PSIKOLOG`; hanya sesi miliknya (sesi psikolog lain → `404`).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/psikolog/sesi?cakupan=&limit=` | `mendatang` (default, urut waktu naik), `riwayat`, `semua`; memuat `mahasiswa { id, nama }` |
| GET | `/psikolog/sesi/:id` | Detail + `keluhan_awal` terdekripsi + NIM; diaudit `SESI_DETAIL_READ`, `Cache-Control: no-store` |
| PATCH | `/psikolog/sesi/:id/status` | `{ status: 'BERLANGSUNG' \| 'SELESAI' \| 'TIDAK_HADIR' }`; diaudit `SESI_STATUS_UBAH` |

```
DIJADWALKAN ──mulai──► BERLANGSUNG ──► SELESAI
     └──(setelah jam mulai, mahasiswa tak datang)──► TIDAK_HADIR
```

| Transisi | Syarat | Error |
|---|---|---|
| → `BERLANGSUNG` | dari `DIJADWALKAN`, paling cepat `SESI_MULAI_LEBIH_AWAL_MENIT` (10) sebelum jadwal dan sebelum jadwal berakhir | `422 DI_LUAR_WAKTU_SESI` |
| → `SELESAI` | dari `BERLANGSUNG` | `409 TRANSISI_TIDAK_VALID` |
| → `TIDAK_HADIR` | dari `DIJADWALKAN`, setelah jadwal mulai | `422 DI_LUAR_WAKTU_SESI` |
| status sama | — | `409 STATUS_SUDAH_SAMA` |

Syarat status dan waktu diperiksa di satu `UPDATE` bersyarat (atomik). Setelah berhasil,
event `sesi:status` disiarkan ke room sesi; sesi yang berakhir menutup room sehingga chat dan
signaling berhenti. Status `SELESAI`/`TIDAK_HADIR` melepas slot dari exclusion constraint.

## 2. Ruang sesi dengan enkripsi end-to-end (NFR-02)

### Prinsip

- Server **hanya** menyimpan kunci **publik** (`kunci_e2ee`) dan **ciphertext** (`sesi_pesan`).
  Kunci privat dibuat dan disimpan di perangkat (WebCrypto, `extractable: false`, IndexedDB),
  sehingga server, admin DB, maupun backup tidak dapat membaca isi chat.
- Hanya dua peserta sesi (mahasiswa pemesan dan psikolog yang dibooking) yang dapat mengakses
  room, kunci lawan bicara, dan riwayat ciphertext. Peserta lain → `404` (keberadaan sesi tidak bocor).
- Pesan hanya dapat dikirim saat sesi `BERLANGSUNG`; pemeriksaan status dilakukan di statement
  `INSERT` yang sama sehingga tidak ada celah ketika psikolog mengakhiri sesi.

### Endpoint REST

| Method | Path | Role | Keterangan |
|---|---|---|---|
| PUT / POST | `/me/kunci-e2ee` | Mhs, Psi | `{ kunci_publik }` SPKI DER base64 (EC P-256 atau X25519); upsert. Respons memuat `sidik_jari` |
| GET | `/me/kunci-e2ee` | Mhs, Psi | Kunci sendiri (`404 KUNCI_BELUM_ADA`) |
| GET | `/sesi/:id/kunci` | Peserta | Kunci publik lawan bicara (`404 KUNCI_LAWAN_BELUM_ADA`) |
| GET | `/sesi/:id/pesan?setelah=&limit=` | Peserta | Riwayat ciphertext (urut waktu; `setelah` ISO berzona untuk sinkronisasi) |
| POST | `/sesi/:id/pesan` | Peserta | `{ ciphertext, nonce }` — fallback HTTP; tetap disiarkan ke room |

Batas: `ciphertext` 16 B–16 KiB, `nonce` 12–32 B (base64 kanonis), `kunci_publik` ≤ 1 KiB.
Kunci RSA atau byte acak ditolak `400 KUNCI_TIDAK_VALID`.

### Socket.IO namespace `/sesi`

Klien: `io('<origin>/sesi', { auth: { token: accessToken } })` — role `MAHASISWA` atau `PSIKOLOG`.
Setiap event memakai ack `{ ok, kode?, pesan?, data? }`.

| Event | Arah | Payload |
|---|---|---|
| `sesi:gabung` | klien → server | `{ id_sesi }` — hanya peserta, sesi `DIJADWALKAN`/`BERLANGSUNG` |
| `pesan:kirim` | klien → server | `{ id_sesi, ciphertext, nonce }`; ack `data` = pesan tersimpan |
| `pesan:baru` | server → room | `{ id_pesan, id_sesi, pengirim, ciphertext, nonce, created_at }` |
| `rtc:sinyal` | klien ↔ klien | `{ id_sesi, data }` → diteruskan ke peserta lain sebagai `{ id_sesi, dari, data }`; tidak disimpan; ≤ 16 000 karakter; hanya saat `BERLANGSUNG` dan setelah bergabung |
| `sesi:status` | server → room | `{ id_sesi, status_sesi }` |
| `token:kedaluwarsa` | server → klien | Access token habis; sambung ulang dengan token hasil refresh |

Anti-banjir: maks. `SESI_MAKS_PESAN_PER_10_DETIK` (30) pesan/sinyal per socket per 10 detik
(`TERLALU_CEPAT`). Setiap event memeriksa ulang keanggotaan & status sesi ke DB.

Untuk sesi `SUARA`, `rtc:sinyal` mengangkut offer/answer/ICE WebRTC. Media WebRTC sudah
terenkripsi DTLS-SRTP antar-peer. Bila jaringan kampus membutuhkan TURN, siapkan server TURN
terpisah; TURN hanya meneruskan paket terenkripsi.

### Skema kriptografi yang disarankan untuk frontend

Server tidak bergantung pada algoritma, tetapi kedua klien harus sepakat. Rekomendasi (WebCrypto):

1. Pasangan kunci ECDH P-256 per perangkat; unggah `exportKey('spki', publicKey)` ke `/me/kunci-e2ee`.
2. Ambil kunci lawan dari `/sesi/:id/kunci`; bandingkan `sidik_jari` secara lisan/visual bila
   ingin memastikan tidak ada penukaran kunci (perlindungan terhadap server yang disusupi).
3. `deriveBits(ECDH)` → HKDF-SHA-256 (`salt = id_sesi`, `info = "denger-sesi-v1"`) → kunci AES-GCM 256.
4. Tiap pesan: nonce acak 12 byte, `AES-GCM(plaintext, additionalData = id_sesi + ":" + role_pengirim)`.

Konsekuensi yang perlu dikomunikasikan di UI: mengganti kunci (perangkat baru, hapus data
browser) membuat pesan lama tidak dapat didekripsi di perangkat tersebut. Ini sifat E2EE,
bukan bug.

Penghapusan akun mahasiswa (PBI-03) menghapus kunci publiknya.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/sesi
```

Manual: booking sesi (PBI-10) → psikolog `PATCH /psikolog/sesi/:id/status {"status":"BERLANGSUNG"}`
dalam 10 menit sebelum jadwal → kedua pihak `PUT /me/kunci-e2ee`, bergabung `sesi:gabung`, kirim
`pesan:kirim`. Periksa di DB bahwa `sesi_pesan.ciphertext` bukan teks yang dapat dibaca.

## Kriteria penerimaan PBI-11

- [x] Psikolog melihat jadwal sesi mendatang & riwayatnya, serta detail sesi (akses diaudit).
- [x] Psikolog memulai, menyelesaikan, atau menandai mahasiswa tidak hadir sesuai aturan waktu.
- [x] Mahasiswa dan psikolog bertukar pesan terenkripsi end-to-end; server hanya menyimpan ciphertext.
- [x] Hanya peserta sesi yang dapat mengakses ruang sesi; pesan ditolak di luar sesi berlangsung.
- [x] Signaling WebRTC untuk sesi suara tersedia tanpa menyimpan isi sinyal.
