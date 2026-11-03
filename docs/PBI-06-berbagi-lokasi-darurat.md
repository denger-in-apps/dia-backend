# PBI-06 [BE] Berbagi Lokasi Darurat — SCRUM-226

**Description**

Sebagai mahasiswa, saya ingin memilih berbagi lokasi saat SOS agar psikolog dapat menjangkau saya.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: Berbagi Lokasi Darurat; Bab 4.3 ERD: `LOG_SOS`; FR: FR-MHS-04.

## Prinsip

- **Pilihan mahasiswa.** Lokasi hanya dikirim bila mahasiswa memilih berbagi.
  SOS tetap terkirim tanpa lokasi. Koordinat berasal dari Browser Geolocation
  API di perangkat, bukan dari API peta (klarifikasi KT-08).
- **Bisa diberikan belakangan dan dicabut** selama SOS berjalan.
- **Hanya penangan kasus** yang dapat membaca lokasi, dan setiap akses diaudit.
- **Minimisasi data:** koordinat dihapus saat izin dicabut, SOS dibatalkan, atau
  akun dihapus.

## Endpoint

Prefix `/api/v1`, Bearer token.

| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | `/genta/sos` | Mahasiswa | Field opsional `lokasi: { lat, lng, akurasi_m? }` (lihat PBI-05) |
| PATCH | `/genta/sos/:id/lokasi` | Mahasiswa | Bagikan/perbarui lokasi pada SOS milik sendiri yang masih berjalan |
| DELETE | `/genta/sos/:id/lokasi` | Mahasiswa | Cabut izin; koordinat dihapus |
| GET | `/psikolog/sos/:id/lokasi` | Psikolog | Lokasi untuk psikolog penangan kasus |

Validasi koordinat: `lat` −90..90, `lng` −180..180, `akurasi_m` 0..100000 (meter),
berupa angka, dan field lain ditolak `400`. Kirim ulang SOS (retry) yang membawa
lokasi akan menyimpan lokasi pada SOS aktif yang sama.

Respons psikolog: `{ id_sos, lat, lng, akurasi_m, dicatat_at, lokasi_diperbarui_at, peta_url }`
dengan header `Cache-Control: no-store`. `peta_url` (OpenStreetMap) hanya untuk
tampilan.

| Kondisi | Respons |
|---|---|
| Psikolog bukan penangan, atau kasus belum diambil/sudah selesai | `403 BUKAN_PENANGAN_KASUS` (dicatat `SOS_LOKASI_READ` hasil `DITOLAK`) |
| Mahasiswa tidak membagikan lokasi | `404 LOKASI_TIDAK_DIBAGIKAN` |
| Berhasil | `200` (dicatat `SOS_LOKASI_READ` hasil `SUKSES`) |
| Mahasiswa berbagi lokasi ke SOS yang sudah selesai | `409 SOS_SUDAH_SELESAI` |

Kasus diambil psikolog melalui dashboard penanganan SOS (SCRUM-232); setelah itu
`log_sos.id_psikolog` terisi dan lokasi dapat dibaca penangan tersebut.

## Penyimpanan

Koordinat disimpan sebagai JSON `{ lat, lng, akurasi_m, dicatat_at }` yang dienkripsi
AES-256-GCM di `log_sos.koordinat_lokasi_enc` dengan AAD
`log_sos:koordinat_lokasi_enc:<id_sos>`. Constraint skema awal
`log_sos_lokasi_konsisten` menjamin koordinat hanya ada bila `lokasi_izin = true`.
Migrasi `1793700200000-GentaLokasi` menambah `lokasi_diperbarui_at`.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/genta
```

## Kriteria penerimaan

- [x] Mahasiswa dapat memilih menyertakan lokasi saat SOS, menambahkannya kemudian, atau mencabutnya.
- [x] Koordinat tersimpan terenkripsi dan terikat ke baris SOS.
- [x] Hanya psikolog penangan kasus aktif yang dapat membaca lokasi; role lain `403`.
- [x] Setiap akses lokasi (berhasil/ditolak) tercatat di audit log.
- [x] Koordinat dihapus saat izin dicabut atau SOS dibatalkan.
