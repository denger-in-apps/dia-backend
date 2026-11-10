# PBI-09 Eskalasi SOS & Pengelolaan Jadwal Jaga

**Description**

Sebagai mahasiswa, saya ingin SOS tereskalasi otomatis bila tidak direspons; sebagai dosen admin, saya ingin mengatur eskalasi serta akun dan jadwal jaga psikolog.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA (alternatif 3.a–3.b); Bab 4.3 ERD: `LOG_SOS`, `KONTAK_DARURAT`, `JADWAL_JAGA`; FR: FR-ADM-05, FR-ADM-02.

Catatan: judul FR-ADM-02 menyebut "petugas", tetapi deskripsinya hanya psikolog; diasumsikan hanya psikolog.

| Subtask | Jira | Bagian |
|---|---|---|
| [BE] Timer eskalasi 3 menit (Redis) | SCRUM-234 | [§1](#1-timer-eskalasi-scrum-234) |
| [BE] Integrasi SMS Gateway ke kontak darurat dan hotline 119 ext. 8 | SCRUM-235 | [§2](#2-sms-gateway--hotline-scrum-235) |

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

Dijalankan sekali oleh pemenang eskalasi atomik §1, sehingga retry job atau sweeper
tidak mengirim SMS ganda.

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

Penerima eskalasi kampus tetap selalu dikabari pada semua kondisi di atas. Nilai default
kebijakan dapat diatur Dosen Admin (SCRUM-236).

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

Migrasi `1793700400000-EskalasiSms` menambah `log_eskalasi.jenis_penerima`.

### Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/eskalasi
```

Dengan `SMS_PROVIDER=console`, log API menampilkan baris `[SIMULASI] SMS ke 0812*****890`
untuk setiap penerima saat SOS tereskalasi.
