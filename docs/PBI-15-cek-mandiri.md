# PBI-15 Cek Mandiri (PHQ-9 & GAD-7) — SCRUM-258

**Description**

Sebagai mahasiswa, saya ingin mengisi kuesioner agar mengenali kondisi diri dan tahu langkah lanjutan.

**Referensi proposal:** Tabel 5.1 Sprint 4 (Pendampingan & Dukungan Mahasiswa); Bab 4.1 Use Case: Cek Mandiri; Bab 4.3 ERD: `HASIL_CEK_MANDIRI`; FR: FR-MHS-08.

Semua endpoint: prefix `/api/v1`, Bearer token, hanya role `MAHASISWA`, hanya data milik sendiri.
Psikolog dan Dosen Admin tidak dapat membaca hasil individu (Admin hanya agregat, PBI-20).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/cek-mandiri/template` | Template aktif versi terbaru: `{ id_template, kode, nama, versi, butir: { pertanyaan_pembuka, butir[], opsi[] } }` |
| POST | `/cek-mandiri` | `{ id_template_phq9?, jawaban_phq9?: number[9], id_template_gad7?, jawaban_gad7?: number[7] }` |
| GET | `/cek-mandiri/riwayat?limit=` | Skor & tingkat per pengisian (tanpa jawaban rinci) |
| GET | `/cek-mandiri/:id` | Detail + jawaban rinci terdekripsi |
| DELETE | `/cek-mandiri/:id` | Hapus hasil milik sendiri |

Minimal satu kuesioner diisi; tiap kuesioner butuh pasangan `id_template_*` + `jawaban_*`
(`422 PASANGAN_TIDAK_LENGKAP`). Jawaban bernilai 0–3; jumlahnya harus tepat 9 (PHQ-9) / 7 (GAD-7)
(`422 JUMLAH_JAWABAN_TIDAK_SESUAI`); template harus aktif dan sesuai kode (`422 TEMPLATE_TIDAK_VALID`).
Klien **tidak** dapat mengirim skor (`400`, field tak dikenal).

## Penilaian (02-backend.md §9.1)

| Kuesioner | Minimal | Ringan | Sedang | Sedang-berat | Berat |
|---|---|---|---|---|---|
| PHQ-9 (0–27) | 0–4 | 5–9 | 10–14 | 15–19 | 20–27 |
| GAD-7 (0–21) | 0–4 | 5–9 | 10–14 | — | 15–21 |

Rekomendasi berbasis aturan, memakai tingkat tertinggi dari kuesioner yang diisi:

| Kondisi | `rekomendasi.kode` | `tindakan` |
|---|---|---|
| **PHQ-9 butir 9 > 0** (pikiran menyakiti diri) atau tingkat berat | `BANTUAN_SEGERA` | `GENTA`, `HOTLINE`, `BOOKING_PRIORITAS` + `jalur_bantuan_segera: true` + `hotline` dari `konfigurasi_sos` |
| Sedang / sedang-berat | `KONSELING` | `BOOKING`, `SUMBER_DAYA` |
| Ringan | `DUKUNGAN_SEBAYA` | `CIRCLE`, `CEK_ULANG`, `SUMBER_DAYA` |
| Minimal | `PERAWATAN_DIRI` | `SUMBER_DAYA`, `CEK_ULANG` |

Butir 9 positif selalu memicu jalur bantuan segera walaupun total skor minimal — praktik
keselamatan standar pada skrining. Setiap respons memuat `disclaimer` bahwa hasil **bukan diagnosis**
(pascakondisi use case).

## Penyimpanan & privasi

- Skor, tingkat, `butir9_positif`, dan kode rekomendasi disimpan polos untuk laporan agregat
  anonim (`v_laporan_cek_mandiri_bulanan`, PBI-20).
- Jawaban rinci dienkripsi AES-256-GCM, AAD `hasil_cek_mandiri:jawaban_enc:<id_cek>`; hapus akun
  (PBI-03) mengosongkan kolom ini (skor tetap untuk statistik anonim).
- Batas `CEK_MANDIRI_MAKS_PER_HARI` (20) pengisian per akun per 24 jam (`429 CEK_MANDIRI_TERLALU_SERING`),
  dihitung di bawah advisory lock per mahasiswa.

## Template

Migrasi `1793900000000-TemplateCekMandiri` menanam PHQ-9 v1 dan GAD-7 v1 berbahasa Indonesia.

> ⚠️ **Wajib sebelum rilis:** PHQ-9/GAD-7 bebas dipakai (public domain), tetapi teks terjemahan
> harus diverifikasi psikolog/PO terhadap versi Indonesia yang tervalidasi. Revisi dibuat sebagai
> **versi baru** (bukan mengubah versi lama) agar hasil lama tetap merujuk template aslinya,
> lewat `/admin/template-kuesioner` (PBI-20 §2).

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/cek-mandiri
```

## Kriteria penerimaan PBI-15

- [x] Mahasiswa dapat mengisi PHQ-9 dan/atau GAD-7 dari template aktif.
- [x] Skor, tingkat, dan rekomendasi dihitung server sesuai pita standar; hasil bukan diagnosis.
- [x] Butir 9 PHQ-9 positif selalu menampilkan jalur bantuan segera (Genta + hotline).
- [x] Jawaban rinci tersimpan terenkripsi; mahasiswa dapat melihat riwayat, detail, dan menghapus hasilnya.
