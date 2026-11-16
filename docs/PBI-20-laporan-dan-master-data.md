# PBI-20 Laporan Agregat dan Master Data — SCRUM-274, SCRUM-275

**Description**

Sebagai dosen admin, saya ingin melihat tren kesejahteraan secara anonim dan mengelola master data.

**Referensi proposal:** Tabel 5.1 Sprint 5 (Integrasi, Pengujian & Rilis); Bab 4.1 Use Case: -; Bab 4.3 ERD: `DOSEN_ADMIN`, `CIRCLE`, `HASIL_CEK_MANDIRI` (agregat); FR: FR-ADM-04, FR-ADM-07.

## 1. Laporan agregat anonim (SCRUM-274)

Prefix `/api/v1`, Bearer token, hanya role `DOSEN_ADMIN`. Query periode opsional
`?dari=YYYY-MM&sampai=YYYY-MM` (inklusif; default 12 bulan terakhir; maks. 36 bulan, `400 PERIODE_TIDAK_VALID`).

| Method | Path | Isi |
|---|---|---|
| GET | `/admin/laporan/ringkasan` | Total semua laporan untuk dashboard dalam satu panggilan |
| GET | `/admin/laporan/genta` | Per bulan: `total_sos`, `total_eskalasi` |
| GET | `/admin/laporan/cek-mandiri` | Per bulan × tingkat PHQ-9 × tingkat GAD-7: `jumlah` + total per tingkat |
| GET | `/admin/laporan/sesi` | Per bulan × tipe × status sesi konseling + total per status |
| GET | `/admin/laporan/curhat` | Per bulan: `total_curhat`, `total_dijawab` |
| GET | `/admin/laporan/circle` | Kondisi saat ini per kategori × status: jumlah Circle, jumlah anggota |

Setiap respons berbentuk `{ periode?, data[], total, catatan }`.

### Anonimitas (02-backend.md §9.5)

1. **Least privilege di database.** Modul laporan memakai koneksi terpisah role `denger_report`
   (`REPORT_DATABASE_URL`), yang hanya punya `SELECT` pada view `v_laporan_*`. Bug di modul
   ini pun tidak dapat membaca tabel berisi data individu.
2. **Grup kecil dibuang di view** (`HAVING count(*) >= 5`).
3. **Sel kecil disamarkan di service.** Setiap angka 1–4 dikembalikan `null` (misalnya
   `total_eskalasi` yang kecil di bulan yang lolos). Angka 0 dan ≥ 5 ditampilkan.
4. **Tidak ada endpoint laporan yang menerima id individu.** Query tak dikenal ditolak `400`.

Karena sel kecil dibuang/disamarkan, **total adalah batas bawah** (jumlah sel yang ditampilkan),
bukan angka pasti. Sampaikan ini di UI dashboard.

Migrasi `1794000000000-LaporanAgregat` menambah `v_laporan_sesi_bulanan` dan
`v_laporan_curhat_bulanan` (aturan sama, `GRANT SELECT` hanya untuk `denger_report`).
`REPORT_DATABASE_URL` sudah dibentuk Compose dan kini wajib saat boot (validasi env).

## 2. Master data (SCRUM-275)

Prefix `/api/v1`, Bearer token, hanya role `DOSEN_ADMIN` (modul `master-data`). Semua perubahan
diaudit.

### Kategori minat

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/kategori-minat` | Semua kategori + `circle_aktif`, `circle_total` |
| POST | `/admin/kategori-minat` | `{ nama }` (2–60) — `409 KATEGORI_SUDAH_ADA` bila nama dipakai |
| PATCH | `/admin/kategori-minat/:id` | `{ nama?, aktif? }` — nonaktif = tidak bisa dipilih untuk Circle/preferensi baru |
| DELETE | `/admin/kategori-minat/:id` | Hanya bila belum dipakai Circle (`409 KATEGORI_DIPAKAI` → nonaktifkan saja); preferensi mahasiswa ikut dihapus |

Audit: `KATEGORI_MINAT_BUAT`, `KATEGORI_MINAT_UBAH`, `KATEGORI_MINAT_HAPUS`. Endpoint ini dipindah
dari modul Circle (sebelumnya ditarik ke SCRUM-264) tanpa perubahan path.

### Template kuesioner (cek mandiri, PBI-15)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/template-kuesioner?kode=` | Semua versi: `versi`, `aktif`, `jumlah_butir`, `jumlah_dipakai`, `dibuat_oleh` |
| GET | `/admin/template-kuesioner/:id` | Detail + isi `butir` |
| POST | `/admin/template-kuesioner` | `{ kode: PHQ9\|GAD7, nama, butir: { pertanyaan_pembuka, butir[{no,teks}], opsi[{nilai,label}] } }` → versi baru **nonaktif** |
| POST | `/admin/template-kuesioner/:id/aktifkan` | Jadikan satu-satunya versi aktif untuk kodenya |
| DELETE | `/admin/template-kuesioner/:id` | Hanya versi nonaktif yang belum pernah dipakai hasil cek mandiri |

Aturan:

- **Template tidak dapat diubah setelah dibuat.** Revisi (mis. hasil verifikasi terjemahan) dibuat
  sebagai versi baru lalu diaktifkan; hasil cek mandiri lama tetap merujuk template yang dipakainya.
- Isi divalidasi agar skor tetap sahih: PHQ-9 tepat 9 butir, GAD-7 tepat 7 butir, bernomor
  1..n berurutan (`422 BUTIR_TIDAK_VALID`), dan tepat 4 opsi bernilai 0–3 (`422 OPSI_TIDAK_VALID`).
- Paling banyak satu versi aktif per kode — dijamin indeks unik parsial `uq_template_kuesioner_aktif`
  (migrasi `1794000100000-TemplateKuesionerAktifTunggal`). Tidak ada endpoint "nonaktifkan" agar
  cek mandiri tidak pernah kehilangan template; pindah versi lewat `aktifkan`.
- Versi aktif tidak dapat dihapus (`409 TEMPLATE_AKTIF`); versi yang sudah dipakai disimpan
  (`409 TEMPLATE_DIPAKAI`).
- Audit: `TEMPLATE_KUESIONER_BUAT`, `TEMPLATE_KUESIONER_AKTIFKAN` (beserta versi yang digantikan),
  `TEMPLATE_KUESIONER_HAPUS`.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/laporan src/modules/master-data
```

## Kriteria penerimaan PBI-20

- [x] Dosen Admin melihat tren SOS, cek mandiri, sesi konseling, curhat, dan Circle per bulan.
- [x] Laporan hanya dibaca dari view agregat lewat role database `denger_report`; sel 1–4 disembunyikan.
- [x] Dosen Admin mengelola kategori minat (tambah, ubah, nonaktifkan, hapus bila belum dipakai).
- [x] Dosen Admin mengelola template kuesioner berversi tanpa merusak skor dan hasil lama; semua perubahan diaudit.
