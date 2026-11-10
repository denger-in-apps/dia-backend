# PBI-09 Eskalasi SOS & Pengelolaan Jadwal Jaga

**Description**

Sebagai mahasiswa, saya ingin SOS tereskalasi otomatis bila tidak direspons; sebagai dosen admin, saya ingin mengatur eskalasi serta akun dan jadwal jaga psikolog.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA (alternatif 3.a–3.b); Bab 4.3 ERD: `LOG_SOS`, `KONTAK_DARURAT`, `JADWAL_JAGA`; FR: FR-ADM-05, FR-ADM-02.

Catatan: judul FR-ADM-02 menyebut "petugas", tetapi deskripsinya hanya psikolog; diasumsikan hanya psikolog.

| Subtask | Jira | Bagian |
|---|---|---|
| [BE] Timer eskalasi 3 menit (Redis) | SCRUM-234 | [§1](#1-timer-eskalasi-scrum-234) |

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
