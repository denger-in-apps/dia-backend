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

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/laporan
```

## Kriteria penerimaan PBI-20 (laporan)

- [x] Dosen Admin melihat tren SOS, cek mandiri, sesi konseling, curhat, dan Circle per bulan.
- [x] Laporan hanya dibaca dari view agregat lewat role database `denger_report`; sel 1–4 disembunyikan.
