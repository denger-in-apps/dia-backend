# PBI-07 [BE] Notifikasi Real-time Psikolog — SCRUM-229

**Description**

Sebagai psikolog yang bertugas, saya ingin menerima notifikasi SOS seketika agar dapat segera merespons.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA (langkah 3); Bab 4.3 ERD: `LOG_SOS`, `PSIKOLOG`; FR: FR-PSI-03.

## Koneksi realtime

Socket.IO, namespace **`/psikolog`** (path default `/socket.io`, melewati gateway Nginx
yang sudah meneruskan header `Upgrade`).

```ts
import { io } from 'socket.io-client';
const socket = io('https://<host>/psikolog', { auth: { token: accessToken }, withCredentials: true });
socket.on('sos:baru', (sos) => { /* tampilkan alarm + muat ulang antrean */ });
socket.on('sos:diperbarui', (perubahan) => { /* perbarui antrean */ });
socket.on('sesi:kedaluwarsa', () => { /* refresh token lalu sambung ulang */ });
socket.on('connect_error', (err) => { /* err.message === 'TIDAK_TERAUTENTIKASI' */ });
```

- Token dikirim lewat `auth.token` (disarankan) atau header `Authorization: Bearer`.
  Token di query string **tidak** diterima agar tidak tercatat di log.
- Handshake memakai verifikasi yang sama dengan API HTTP (`AccessTokenService`):
  tanda tangan RS256, issuer/audience, dan akun psikolog `AKTIF`. Role lain, token
  tidak valid, atau akun nonaktif ditolak dengan `connect_error: TIDAK_TERAUTENTIKASI`.
- Koneksi diputus saat access token kedaluwarsa (event `sesi:kedaluwarsa`);
  klien melakukan `POST /auth/refresh` lalu menyambung ulang.
- CORS mengikuti `CORS_ORIGINS`.

## Event

| Event | Penerima | Payload |
|---|---|---|
| `sos:baru` | Psikolog yang sedang jaga | `{ id_sos, prioritas, situasi, situasi_label, waktu_kejadian, lokasi_tersedia, perlu_verifikasi, tanpa_jaga }` |
| `sos:diperbarui` | Semua psikolog terhubung | `{ id_sos, status_penanganan, id_psikolog }` (dipakai dashboard SCRUM-232) |
| `sos:lokasi` | Psikolog penangan (kasus diambil) atau semua psikolog (kasus di antrean) | `{ id_sos, lokasi_tersedia, lokasi_diperbarui_at }` — tanpa koordinat (PBI-06) |
| `sesi:kedaluwarsa` | Socket bersangkutan | `{ kode: 'TOKEN_KEDALUWARSA' }` |

Payload **tidak memuat identitas mahasiswa**. Notifikasi realtime dan push dapat
terlihat di layar terkunci; detail kasus diambil lewat dashboard yang terautentikasi.

## Penentuan penerima

1. Psikolog berstatus `AKTIF` yang terjadwal di `jadwal_jaga` pada tanggal & jam
   sekarang, dihitung pada zona `JADWAL_ZONA_WAKTU` (default `Asia/Jakarta`).
   Jadwal dibaca langsung dari `jadwal_jaga`, tidak dari `status_jaga` (04-database.md §4.f).
2. Bila tidak ada yang jaga, **semua psikolog aktif** dikabari dengan `tanpa_jaga: true`
   agar SOS tidak pernah tanpa penerima. Eskalasi otomatis (SMS/hotline) adalah PBI-09.

Event dikirim segera setelah transaksi SOS di-commit (tanpa menunda respons ke
mahasiswa), lalu notifikasi in-app disimpan ke tabel `notifikasi` (`jenis = SOS_BARU`)
untuk psikolog yang sedang offline. Kegagalan notifikasi dicatat di log dan **tidak**
menggagalkan pembuatan SOS.

## Notifikasi in-app (semua role)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/v1/notifikasi?belum_dibaca=true&limit=50` | Notifikasi milik sendiri, terbaru dulu (`limit` 1–100) |
| POST | `/api/v1/notifikasi/:id/dibaca` | Tandai dibaca (`404` bila bukan milik sendiri) |

## Skala (multi-instance)

`main.ts` memasang `RedisIoAdapter` (`@socket.io/redis-adapter`) sehingga event
sampai ke klien di instance API mana pun. Bila Redis tidak dapat dijangkau saat
start, API tetap berjalan dengan adapter in-memory (cukup untuk satu instance) dan
mencatat peringatan. Set `REALTIME_REDIS_ADAPTER=false` untuk mematikannya.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/realtime
```

Test gateway menjalankan server Socket.IO sungguhan dan klien `socket.io-client`:
penolakan handshake, pengiriman tertarget < 5 detik, siaran pembaruan, dan pemutusan
saat token kedaluwarsa.

## Kriteria penerimaan

- [x] Psikolog jaga menerima `sos:baru` seketika (< 5 detik) setelah SOS dibuat.
- [x] Hanya psikolog terautentikasi dan aktif yang dapat tersambung; role lain ditolak.
- [x] Tidak ada SOS tanpa penerima: fallback ke semua psikolog aktif.
- [x] Notifikasi tersimpan untuk psikolog offline dan dapat ditandai dibaca.
- [x] Payload tidak memuat identitas mahasiswa.
