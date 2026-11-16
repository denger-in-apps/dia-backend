# PBI-21 Audit Log Keamanan — SCRUM-277

**Description**

Sebagai dosen admin, saya ingin meninjau log akses data sensitif agar audit keamanan dapat dilakukan.

**Referensi proposal:** Tabel 5.1 Sprint 5 (Integrasi, Pengujian & Rilis); Bab 4.1 Use Case: -; Bab 4.3 ERD: Log akses data sensitif (Arsitektur: Data Layer); FR: FR-ADM-06.

## Endpoint

Prefix `/api/v1`, Bearer token, hanya role `DOSEN_ADMIN`. **Tidak ada** endpoint ubah atau hapus.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/admin/audit-log` | Entri terbaru dulu: `{ data[], berikutnya }` (kursor `id_log`) |
| GET | `/admin/audit-log/aksi` | Kode aksi 90 hari terakhir + `jumlah`, `ditolak` (untuk pilihan filter) |
| GET | `/admin/audit-log/ekspor` | CSV (maks. 10 000 baris terbaru sesuai filter), `Content-Disposition: attachment` |

**Filter** (semua opsional, juga berlaku untuk ekspor):

| Query | Contoh |
|---|---|
| `aktor` (uuid), `aktor_role` | `aktor_role=PSIKOLOG` |
| `aksi` (kode dipisah koma) | `aksi=SOS_LOKASI_READ,CURHAT_READ` |
| `resource_type`, `resource_id` | `resource_type=log_sos&resource_id=<id>` |
| `hasil` | `SUKSES` / `DITOLAK` |
| `dari`, `sampai` | `YYYY-MM-DD` (`sampai` inklusif sampai akhir hari, UTC) atau ISO-8601 berzona |
| `sebelum`, `limit` | kursor dari `berikutnya`; `limit` 1–200 (default 50) |

Setiap entri: `{ id_log, waktu, aktor { id, role, nama }, aksi, resource_type, resource_id, hasil, ip, user_agent, metadata }`.
`aktor.nama` hanya diisi untuk staf (psikolog/dosen admin); aktor mahasiswa cukup diwakili id
(minimisasi data — admin tidak punya relasi ke data pribadi mahasiswa).

## Jaminan integritas

- `audit_log` **append-only**: trigger `audit_log_immutable` menolak `UPDATE/DELETE/TRUNCATE`,
  dan role `denger_app` tidak punya hak `UPDATE/DELETE/TRUNCATE` pada tabel ini (04-database.md §6).
- Isi log hanya metadata (siapa, apa, kapan, dari mana, hasil) — tidak pernah isi data
  (02-backend.md §10).
- **Meta-audit:** setiap pembacaan (`AUDIT_LOG_READ`) dan ekspor (`AUDIT_LOG_EKSPOR`) oleh admin
  ikut dicatat beserta filternya, sehingga penggunaan wewenang ini juga dapat ditelusuri.
- Ekspor CSV mencegah *formula injection*: nilai yang diawali `= + - @` diberi prefiks `'`
  (mis. `user_agent` yang dikendalikan pengguna).
- Migrasi `1794000200000-AuditLogIndeks` menambah indeks `audit_log(aksi, id_log DESC)` dan indeks
  parsial untuk entri `DITOLAK`.

## Aksi yang tercatat

| Kelompok | Aksi |
|---|---|
| Autentikasi & akses | `LOGIN_GAGAL`, **`AKSES_DITOLAK`** (baru), `AUDIT_LOG_READ`, `AUDIT_LOG_EKSPOR` |
| Genta | `SOS_AMBIL`, `SOS_DETAIL_READ`, `SOS_STATUS_UBAH`, `SOS_LOKASI_READ` |
| Konseling | `SESI_DETAIL_READ`, `SESI_STATUS_UBAH`, `SESI_CONSENT_BERI/TARIK`, `SESI_RINGKASAN_CREATE/UPDATE/READ`, `RIWAYAT_SESI_READ` |
| Curhat & Circle | `CURHAT_READ`, `CURHAT_BALAS`, `CIRCLE_SETUJUI/TOLAK/BUAT/UBAH/TUTUP`, `CIRCLE_MODERASI` |
| Data pribadi | `DATA_EKSPOR`, `DATA_HAPUS` |
| Administrasi | `AKUN_PSIKOLOG_*`, `JADWAL_JAGA_*`, `KONFIGURASI_SOS_UBAH`, `PENERIMA_ESKALASI_*`, `KATEGORI_MINAT_*`, `TEMPLATE_KUESIONER_*`, `SUMBER_DAYA_*` |

**`AKSES_DITOLAK`** dicatat oleh `RolesGuard` setiap kali pengguna terautentikasi mencoba endpoint
di luar perannya (`403`): `resource_id` = `METHOD /path` (tanpa query string), `metadata.peran_dibutuhkan`.
Pencatatan bersifat best-effort — kegagalan audit tidak mengubah respons. Permintaan tanpa token
(`401`) tidak dicatat agar log tidak dibanjiri pemindaian anonim.

## Cara cek

```powershell
cd apps/api
npm test -- --runInBand src/modules/audit-log
```

Manual: login sebagai mahasiswa, panggil `GET /api/v1/admin/audit-log` (→ `403`), lalu sebagai
Dosen Admin `GET /api/v1/admin/audit-log?hasil=DITOLAK` menampilkan entri `AKSES_DITOLAK` tersebut.

## Kriteria penerimaan PBI-21

- [x] Dosen Admin dapat meninjau audit log dengan filter aktor, aksi, resource, hasil, dan rentang waktu, serta mengekspornya.
- [x] Audit log tidak dapat diubah/dihapus lewat aplikasi maupun role database aplikasi.
- [x] Percobaan akses di luar peran (`AKSES_DITOLAK`) dan pembacaan audit log oleh admin ikut tercatat.
