# PBI-16 Ruang Curhat Anonim — SCRUM-260, SCRUM-261

**Description**

Sebagai mahasiswa, saya ingin menyampaikan curhat secara anonim; sebagai psikolog, saya ingin membaca dan memberi saran.

**Referensi proposal:** Tabel 5.1 Sprint 4 (Pendampingan & Dukungan Mahasiswa); Bab 4.1 Use Case: Ruang Curhat Anonim; Bab 4.3 ERD: `CURHAT_ANONIM`; FR: FR-MHS-09, FR-PSI-05.

Catatan backlog: sisi psikolog berasal dari FR-PSI-05 (di proposal dipetakan ke PBI-13) dan
ditempatkan di sini karena jadwalnya Sprint 4. **Aturan penanganan curhat berisiko tinggi belum
didefinisikan** — lihat §3.

## 1. Mahasiswa (SCRUM-260)

Prefix `/api/v1`, Bearer token, hanya role `MAHASISWA`, hanya curhat milik sendiri (lainnya `404`).
Semua respons `Cache-Control: no-store`.

| Method | Path | Keterangan |
|---|---|---|
| POST | `/curhat` | `{ isi }` (1–5000 karakter, boleh multi-baris) → curhat + `alias_anonim` + `bantuan` |
| GET | `/curhat?limit=` | Curhat milik sendiri (isi terdekripsi, status, `jumlah_balasan`) |
| GET | `/curhat/:id` | Detail + `balasan[] { isi, waktu, nama_psikolog }` |
| DELETE | `/curhat/:id` | Hapus curhat beserta balasannya |

- **Alias anonim** = `Anonim-` + 6 hex HMAC-SHA256(`id_mahasiswa`), kunci diturunkan (HKDF) dari
  kunci enkripsi aktif. Alias stabil antar curhat sehingga psikolog dapat mengikuti percakapan,
  tetapi tidak dapat dibalik menjadi identitas tanpa kunci server. Rotasi kunci enkripsi
  menghasilkan alias baru untuk curhat berikutnya (alias lama yang tersimpan tidak berubah).
- **Isi** dienkripsi AES-256-GCM, AAD `curhat_anonim:isi_curhat_enc:<id_curhat>`.
- **Batas** `CURHAT_MAKS_PER_JAM` (10) per akun per jam (`429 CURHAT_TERLALU_SERING`, tetap memuat
  info bantuan), dihitung di bawah advisory lock per mahasiswa.
- **Batas anonimitas:** anonim terhadap psikolog dan pengguna lain, **bukan** terhadap sistem
  (tabel menyimpan `id_mahasiswa` untuk pengelolaan internal — 02-backend.md §9.2). Sampaikan ini
  dengan jujur di UI sebelum mahasiswa mengirim curhat.
- Hapus akun (PBI-03) menghapus seluruh curhat mahasiswa.

## 3. Curhat berisiko tinggi (belum didefinisikan)

Karena aturan penanganan belum disepakati PO + psikolog, implementasi memakai default paling aman:

- **Tidak ada** deteksi kata kunci otomatis dan **tidak ada** pembukaan identitas otomatis
  (keputusan etik yang belum disetujui — 02-backend.md §9.2).
- Setiap respons `POST /curhat` (termasuk saat kena batas) memuat
  `bantuan { pesan, hotline }` — curhat tidak dipantau setiap saat, dan mahasiswa dalam bahaya
  diarahkan ke Genta/hotline. FE wajib menampilkannya.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/curhat
```

## Kriteria penerimaan PBI-16 (mahasiswa)

- [x] Mahasiswa dapat mengirim curhat yang tersimpan terenkripsi dengan alias anonim stabil.
- [x] Mahasiswa dapat melihat curhat dan balasan psikolog miliknya, serta menghapusnya.
- [x] Setiap pengiriman menyertakan info bantuan darurat (Genta + hotline).
