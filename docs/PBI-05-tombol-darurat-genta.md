# PBI-05 [BE] Tombol Darurat Genta (SOS) — SCRUM-223

**Description**

Sebagai mahasiswa, saya ingin menekan tombol SOS dengan cepat agar mendapat bantuan saat darurat.

**Referensi proposal:** Tabel 5.1 Sprint 2 (Genta / SOS Darurat); Bab 4.1 Use Case: GENTA; Bab 4.3 ERD: `LOG_SOS`; FR: FR-MHS-03.

Tambahan dari PO: validasi bahwa yang menekan benar-benar membutuhkan bantuan, bukan iseng.

## Alur

```
FE tombol SOS ─► POST /genta/sos/konfirmasi  → token_konfirmasi (2 menit), pilihan situasi, hotline
   dialog "Apa yang terjadi?" (pengguna memilih situasi)
FE ─► POST /genta/sos { token_konfirmasi, situasi, konfirmasi: true }
   → 201 SOS baru  | 200 SOS aktif yang sudah ada (idempoten)
```

Semua endpoint: prefix `/api/v1`, Bearer token, hanya role `MAHASISWA`.

| Method | Path | Keterangan |
|---|---|---|
| POST | `/genta/sos/konfirmasi` | Token konfirmasi + `situasi_opsi[]` + `hotline` |
| POST | `/genta/sos` | Buat SOS |
| GET | `/genta/sos/aktif` | SOS milik sendiri yang masih berjalan (`sos: null` bila tidak ada) + hotline |
| POST | `/genta/sos/:id/batal` | Batalkan SOS yang **belum diambil** psikolog (salah tekan) |

Kode `situasi` dan prioritas yang ditetapkan server (klien tidak dapat mengirim prioritas):

| `situasi` | Prioritas |
|---|---|
| `INGIN_MENYAKITI_DIRI` | `KRITIS` |
| `DALAM_BAHAYA` | `KRITIS` |
| `SERANGAN_PANIK` | `TINGGI` |
| `BUTUH_PENDAMPINGAN` | `TINGGI` |
| `LAINNYA` | `SEDANG` |

## Validasi anti-iseng

Prinsip: **SOS tidak pernah ditolak hanya karena dicurigai iseng.** Fitur ini
menyangkut keselamatan, jadi kecurigaan hanya menurunkan prioritas dan memberi
tanda bagi psikolog; mahasiswa selalu menerima info hotline.

| Lapis | Penegakan | Hasil bila gagal |
|---|---|---|
| Identitas | JWT + guard: mahasiswa aktif terverifikasi akademik | `401` / `403` |
| Konfirmasi dua langkah | Token RS256 audience `dia-genta-konfirmasi`, terikat ke akun, berlaku `SOS_KONFIRMASI_TTL_DETIK` (120 dtk). Tidak bisa dipertukarkan dengan access token | `422 KONFIRMASI_TIDAK_VALID` |
| Jeda manusiawi | Minimal `SOS_JEDA_MINIMAL_MS` (800 ms) antara konfirmasi dan kirim, menahan klik otomatis/skrip | `422 KONFIRMASI_TERLALU_CEPAT` |
| Sekali pakai | `jti` token disimpan di Redis (NX). Bila Redis mati, pengecekan ini dilewati (fail-open) karena dedupe DB tetap berlaku | `422 KONFIRMASI_SUDAH_DIPAKAI` |
| Pernyataan eksplisit | `konfirmasi: true` dan `situasi` dari daftar tetap | `400` |
| Dedupe | Advisory lock per mahasiswa + indeks unik parsial `uq_log_sos_aktif_per_mahasiswa`. SOS aktif dikembalikan, bukan dibuat ulang | `200` dengan SOS lama |
| Frekuensi | Maks. `sos_maks_per_jam` (5) SOS baru per akun per jam | `429 SOS_TERLALU_SERING` + `detail.hotline` |
| Riwayat penyalahgunaan | ≥ `sos_ambang_iseng_30_hari` (2) laporan ditandai tidak valid dalam 30 hari, atau ≥ `sos_ambang_batal_24_jam` (3) pembatalan dalam 24 jam | SOS **tetap dibuat**, `perlu_verifikasi = true`, prioritas turun satu tingkat; situasi kritis tidak pernah di bawah `TINGGI` |

Ambang frekuensi dan riwayat penyalahgunaan disimpan di `konfigurasi_sos` dan diatur
Dosen Admin lewat `PUT /admin/konfigurasi-sos` (SCRUM-236; minimal 1 SOS/jam sehingga tombol
tidak dapat dimatikan). Durasi token dan jeda minimal tetap diatur lewat env.

`ditandai_iseng` diisi psikolog saat menutup kasus sebagai laporan tidak valid
(dashboard penanganan SOS, SCRUM-232).

## Skema (migrasi `1793700100000-GentaSos`)

Kolom baru pada `log_sos`: `perlu_verifikasi`, `ditandai_iseng`, `alasan_selesai`
(`DITANGANI` | `DIBATALKAN_MAHASISWA` | `LAPORAN_TIDAK_VALID`), constraint kode
`situasi`, dan indeks unik parsial satu SOS aktif per mahasiswa.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/genta
```

Manual (token mahasiswa dari login SSO):

```powershell
$k = curl.exe -k -sS -X POST https://localhost:18443/api/v1/genta/sos/konfirmasi -H "Authorization: Bearer $token" | ConvertFrom-Json
Start-Sleep -Seconds 1
curl.exe -k -i -X POST https://localhost:18443/api/v1/genta/sos -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  --data-raw "{`"token_konfirmasi`":`"$($k.token_konfirmasi)`",`"situasi`":`"SERANGAN_PANIK`",`"konfirmasi`":true}"
```

Harapan: `201`. Mengirim ulang dengan token yang sama → `200` (SOS aktif yang sama).

## Kriteria penerimaan

- [x] Mahasiswa aktif dapat membuat SOS dalam dua langkah singkat; respons memuat hotline.
- [x] Prioritas ditentukan server dari situasi.
- [x] Tekan ganda / retry tidak membuat SOS ganda.
- [x] Token konfirmasi palsu, milik akun lain, kedaluwarsa, terlalu cepat, atau dipakai ulang ditolak.
- [x] Penyalahgunaan berulang dibatasi tanpa menolak SOS yang mungkin nyata.
- [x] Mahasiswa dapat membatalkan SOS yang belum diambil psikolog.
