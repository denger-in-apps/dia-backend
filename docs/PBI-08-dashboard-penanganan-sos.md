# PBI-08 [BE] Dashboard Penanganan SOS — SCRUM-232

**Description**

Sebagai psikolog, saya ingin melihat dan mengambil kasus SOS agar penanganan terstruktur.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA (langkah 3-4); Bab 4.3 ERD: `LOG_SOS`, `PSIKOLOG`; FR: FR-PSI-02.

## Alur penanganan

```
BARU / ESKALASI ──ambil (atomik)──► DIAMBIL ──► DITANGANI ──► SELESAI
                                       └──────────────────────────┘
```

Semua endpoint: prefix `/api/v1`, Bearer token, hanya role `PSIKOLOG`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/psikolog/sos?cakupan=&limit=` | Antrean, urut `prioritas DESC, waktu_kejadian ASC` |
| GET | `/psikolog/sos/:id` | Detail kasus (`Cache-Control: no-store`) |
| POST | `/psikolog/sos/:id/ambil` | Ambil kasus secara atomik |
| PATCH | `/psikolog/sos/:id/status` | `{ status: 'DITANGANI' \| 'SELESAI', catatan?, laporan_tidak_valid? }` |
| GET | `/psikolog/sos/:id/lokasi` | Lokasi bila dibagikan (PBI-06) |

`cakupan`: `aktif` (default; antrean belum diambil + kasus aktif saya), `antrean`,
`milik_saya`, `riwayat` (kasus saya yang selesai, terbaru dulu). `limit` 1–100 (default 50).

## Privasi data

| Data | Kasus di antrean | Kasus yang saya ambil | Kasus psikolog lain |
|---|---|---|---|
| Prioritas, situasi, waktu, `perlu_verifikasi`, lokasi tersedia? | ✓ | ✓ | ✗ (`403`) |
| Nama, NIM, email mahasiswa | ✗ | ✓ (diaudit `SOS_DETAIL_READ`) | ✗ |
| Riwayat 30 hari (jumlah SOS, laporan tidak valid) | ✗ | ✓ | ✗ |
| Catatan penanganan (terdekripsi) | ✗ | ✓ | ✗ |

Identitas mahasiswa baru terbuka setelah psikolog mengambil kasus (minimisasi data).
Riwayat 30 hari membantu menilai kasus bertanda `perlu_verifikasi` (PBI-05).

## Ambil kasus (atomik)

Satu statement bersyarat sesuai 04-database.md §4.c:

```sql
UPDATE log_sos SET id_psikolog = $1, status_penanganan = 'DIAMBIL', waktu_diambil = now()
 WHERE id_sos = $2 AND status_penanganan IN ('BARU', 'ESKALASI') RETURNING ...;
```

| Kondisi | Respons |
|---|---|
| Berhasil | `200`, dicatat `SOS_AMBIL`, siaran `sos:diperbarui` ke semua psikolog terhubung |
| Sudah saya ambil sebelumnya | `200` (idempoten, tanpa audit ganda) |
| Diambil psikolog lain lebih dulu | `409 SOS_SUDAH_DIAMBIL` |
| Sudah selesai | `409 SOS_SUDAH_SELESAI` |

## Ubah status

- Hanya psikolog penangan, dari `DIAMBIL`/`DITANGANI`. Kasus psikolog lain → `403`,
  kasus selesai → `409`.
- `catatan` (1–2000 karakter) disimpan terenkripsi di `catatan_penanganan_enc`
  (AAD `log_sos:catatan_penanganan_enc:<id_sos>`). Bila tidak dikirim, catatan lama dipertahankan.
- `laporan_tidak_valid: true` hanya bersama `SELESAI` dan **wajib** disertai `catatan`.
  Kasus ditandai `ditandai_iseng = true`, `alasan_selesai = 'LAPORAN_TIDAK_VALID'`,
  dan dihitung pada pemeriksaan penyalahgunaan PBI-05.
- `SELESAI` mengisi `waktu_selesai` dan menghapus koordinat lokasi (minimisasi data).
- Dicatat `SOS_STATUS_UBAH` dan disiarkan `sos:diperbarui`.

Migrasi `1793700300000-GentaPenanganan` menambah `waktu_ditangani`,
`catatan_penanganan_enc`, dan indeks `idx_log_sos_psikolog`.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/genta
```

Manual (token psikolog dari `POST /auth/staff/login`):

```powershell
curl.exe -k -s https://localhost:18443/api/v1/psikolog/sos -H "Authorization: Bearer $token"
curl.exe -k -i -X POST https://localhost:18443/api/v1/psikolog/sos/$id/ambil -H "Authorization: Bearer $token"
curl.exe -k -i -X PATCH https://localhost:18443/api/v1/psikolog/sos/$id/status -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" --data-raw '{"status":"SELESAI","catatan":"Sudah didampingi"}'
```

Uji konkurensi: jalankan `ambil` dari dua akun psikolog bersamaan; tepat satu `200`, lainnya `409`.

## Kriteria penerimaan

- [x] Psikolog melihat antrean SOS terurut prioritas lalu waktu.
- [x] Psikolog dapat mengambil kasus; pengambilan bersamaan hanya dimenangkan satu psikolog.
- [x] Psikolog penangan dapat memperbarui status dan catatan; psikolog lain ditolak.
- [x] Identitas mahasiswa hanya terlihat oleh penangan kasus; akses tercatat di audit log.
- [x] Perubahan kasus tersiar ke dashboard psikolog lain secara realtime.
- [x] Laporan tidak valid dapat ditandai (dengan catatan) untuk mendukung validasi anti-iseng.
