# 02 — Backend (NestJS, Modular Monolith)

> **Lingkup Jira:** semua subtask `[BE]` dan `[FE][BE]` (bagian BE) — SET-01, SET-03, PBI-01 s.d. PBI-21, IT-08, IT-09
> **Requirement PRD:** KT-01, KT-02, KT-04, KT-06, KT-07, KT-08 · FR-MHS/PSI/ADM · NFR-02…NFR-05, NFR-08
> **Pemilik utama (Jira):** Muhammad Zacky · sebagian BE: Muhammadjosfi507 (PBI-10, 12, 13), Rayindarari (PBI-19, 20, 21)

---

## 1. Stack

| Kebutuhan | Pilihan | Catatan |
|-----------|---------|---------|
| Runtime | Node.js LTS + TypeScript (strict) | KT-01 |
| Framework | **NestJS** (bukan Express mentah) | KT-02: modular, DI, Swagger otomatis. Express tetap dipakai sebagai adapter bawaan Nest |
| API docs | `@nestjs/swagger` → OpenAPI 3 | FE men-generate tipe klien dari OpenAPI |
| DB access | **TypeORM** (`@nestjs/typeorm`) + migrasi SQL | Skema referensi: `04-database.md`. Prisma/Drizzle juga bisa; pilih satu dan konsisten |
| Validasi | `class-validator` + `class-transformer` (atau `zod` via `nestjs-zod`) | Skema bersama di `packages/shared` bila memakai zod |
| Realtime | `@nestjs/websockets` + `socket.io` + `@socket.io/redis-adapter` | KT-04 |
| Antrean/timer | **BullMQ** (di atas Redis) | Timer eskalasi 3 menit — tahan restart |
| Auth | `@nestjs/passport`, `openid-client` (OIDC) atau `@node-saml/passport-saml` (SAML), `@nestjs/jwt` | KT-07 |
| Hash password staf | `argon2` | Psikolog/Dosen admin (FR-PSI-01, FR-ADM-01) |
| Keamanan HTTP | `helmet`, `@nestjs/throttler`, CORS ketat | |
| Logging | `nestjs-pino` (redact field sensitif) | |
| Jadwal berkala | `@nestjs/schedule` (atau BullMQ repeatable jobs) | Pengingat sesi (PBI-14) |
| Testing | Jest + Supertest + Testcontainers (Postgres/Redis) | |

---

## 2. Inisialisasi (SCRUM-200)

```bash
cd apps/api
pnpm add @nestjs/config @nestjs/typeorm typeorm pg @nestjs/swagger \
  @nestjs/passport passport @nestjs/jwt openid-client \
  @nestjs/websockets @nestjs/platform-socket.io socket.io @socket.io/redis-adapter ioredis \
  @nestjs/bullmq bullmq @nestjs/schedule @nestjs/throttler \
  class-validator class-transformer helmet cookie-parser argon2 nestjs-pino pino-http \
  web-push
pnpm add -D @types/passport @types/cookie-parser @types/pg testcontainers
```

`package.json` scripts yang diharapkan CI (lihat 01-infrastructure.md):

```json
{
  "scripts": {
    "start:dev": "nest start --watch",
    "build": "nest build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:e2e": "jest --config test/jest-e2e.json",
    "migration:run": "typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts",
    "migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/database/data-source.ts",
    "migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/database/data-source.ts",
    "seed": "ts-node src/database/seed/run.ts"
  }
}
```

`main.ts` (konfigurasi minimum):

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
app.use(helmet());
app.use(cookieParser());
app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
app.enableCors({ origin: config.corsOrigins, credentials: true });
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
app.useGlobalFilters(new AllExceptionsFilter());     // format error seragam, tanpa stack ke klien
app.enableShutdownHooks();                           // tutup koneksi WS/BullMQ dengan rapi
SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, docConfig)); // nonaktifkan di produksi
await app.listen(config.port);
```

---

## 3. Struktur Modul & Pemetaan Backlog

```
apps/api/src/
├─ main.ts, app.module.ts
├─ config/                     # validasi env (Joi/zod), fail-fast saat boot
├─ common/
│  ├─ crypto/                  # EncryptionService (AES-256-GCM, key id)
│  ├─ audit/                   # AuditService + @Audit() decorator + interceptor
│  ├─ auth/                    # JwtAuthGuard, RolesGuard, @Roles(), @CurrentUser()
│  ├─ filters/ interceptors/ pipes/ dto/
│  └─ health/                  # /health/live, /health/ready
├─ database/                   # data-source.ts, migrations/, seed/
├─ modules/
│  ├─ auth/                    # PBI-01
│  ├─ akademik/                # PBI-02
│  ├─ akun/                    # PBI-03
│  ├─ admin-staf/              # PBI-09 (akun psikolog, jadwal jaga)
│  ├─ genta/                   # PBI-05, 06, 08, 09
│  ├─ eskalasi/                # PBI-09 (queue processor + SMS)
│  ├─ realtime/                # PBI-07 (Socket.IO gateway)
│  ├─ booking/                 # PBI-10, 12
│  ├─ sesi/                    # PBI-11, 13 (jadwal psikolog, ruang sesi, ringkasan, riwayat)
│  ├─ notifikasi/              # PBI-14 (pengingat)
│  ├─ cek-mandiri/             # PBI-15
│  ├─ curhat/                  # PBI-16
│  ├─ circle/                  # PBI-17, 18
│  ├─ sumber-daya/             # PBI-19
│  ├─ laporan/                 # PBI-20 (FR-ADM-04)
│  ├─ master-data/             # PBI-20 (FR-ADM-07)
│  └─ audit-log/               # PBI-21 (endpoint baca log)
└─ integrations/
   ├─ sso/                     # OidcStrategy | SamlStrategy
   ├─ akademik/                # AkademikClient (http) + MockAkademikClient
   ├─ sms/                     # SmsProvider interface + ConsoleSms + <ProviderTerpilih>
   └─ maps/                    # reverse geocode (opsional)
```

| Modul | PBI | FR | Jira BE |
|-------|-----|----|---------|
| `auth` | PBI-01 | FR-MHS-01, FR-PSI-01, FR-ADM-01 | SCRUM-208 |
| `akademik` | PBI-02 | FR-MHS-02 | SCRUM-210 |
| `akun` | PBI-03 | FR-MHS-12 | SCRUM-213 |
| RBAC (`common/auth`) | PBI-04 | NFR-03; Tabel 3.4 | SCRUM-215 |
| `genta` (SOS + lokasi) | PBI-05, 06 | FR-MHS-03, 04 | SCRUM-223, 226 |
| `realtime` | PBI-07 | FR-PSI-03 | SCRUM-229 |
| `genta` (dashboard psikolog) | PBI-08 | FR-PSI-02 | SCRUM-232 |
| `eskalasi` | PBI-09 | FR-ADM-05 | SCRUM-234, 235, 236 |
| `admin-staf` | PBI-09 | FR-ADM-02 | SCRUM-237 |
| `booking` | PBI-10, 12 | FR-MHS-05 | SCRUM-242, 248 |
| `sesi` | PBI-11, 13 | FR-PSI-04, 05, 08 | SCRUM-244, 245, 251 |
| `notifikasi` | PBI-14 | FR-MHS-11 | SCRUM-253 |
| `cek-mandiri` | PBI-15 | FR-MHS-08 | SCRUM-258 |
| `curhat` | PBI-16 | FR-MHS-09, FR-PSI-05 | SCRUM-260, 261 |
| `circle` | PBI-17, 18 | FR-MHS-06, 07; FR-PSI-06; FR-ADM-07 | SCRUM-263, 264, 266, 267 |
| `sumber-daya` | PBI-19 | FR-MHS-10, FR-PSI-07, FR-ADM-03 | SCRUM-270 |
| `laporan` | PBI-20 | FR-ADM-04 | SCRUM-274 |
| `master-data` | PBI-20 | FR-ADM-07 | SCRUM-275 |
| `audit-log` | PBI-21 | FR-ADM-06, NFR-08 | SCRUM-277 |

**Aturan modular monolith:** modul hanya berkomunikasi lewat *service* yang diekspor (bukan mengimpor repository modul lain), dan lintas-modul via event internal (`@nestjs/event-emitter`) bila perlu. Ini menjaga opsi memecah layanan di masa depan tanpa menambah kompleksitas sekarang (alasan proposal memilih modular monolith).

---

## 4. Konfigurasi & Boot

- Seluruh env divalidasi saat start (Joi/zod). Aplikasi **gagal start** jika `ENCRYPTION_KEY_*`, `JWT_*`, atau `DATABASE_URL` hilang. Jangan ada nilai default untuk rahasia.
- Konfigurasi yang bisa diubah admin saat runtime (durasi eskalasi, penerima) dibaca dari **DB** (`konfigurasi_sos`), bukan env; env hanya nilai awal.
- `/health/live` (proses hidup) dan `/health/ready` (Postgres + Redis terjangkau) — dipakai load balancer dan smoke test.

---

## 5. Autentikasi (PBI-01) — SCRUM-208

### 5.1 Mahasiswa: SSO kampus

```
Browser ─► GET /api/v1/auth/sso/login ──► redirect ke IdP kampus (OIDC authorize / SAML AuthnRequest)
IdP ─► GET|POST /api/v1/auth/sso/callback
         1. validasi state/nonce (OIDC) atau signature (SAML)
         2. ambil klaim: sub, email, nim (nama atribut dikonfirmasi dengan IT kampus)
         3. AkademikService.verifikasi(nim)  ── PBI-02; tidak aktif → 403, sesi tidak diterbitkan
         4. upsert mahasiswa (sso_subject unik)
         5. terbitkan access JWT (15 mnt) + refresh token (7 hr, hash disimpan di DB)
         6. Set-Cookie httpOnly; Secure; SameSite=Lax  → redirect ke landing page
```

Implementasikan **antarmuka** `SsoStrategy` dengan dua implementasi (`Oidc`, `Saml`) dipilih lewat `SSO_PROTOCOL`, karena protokol IdP kampus belum dikonfirmasi. Skenario alternatif dari use case:

| Use case | Perilaku API |
|----------|--------------|
| 2.a Kredensial salah | IdP yang menolak; callback menerima error → redirect `/masuk?error=kredensial` |
| 3.a SSO tidak merespons | Timeout/5xx dari IdP → redirect `/masuk?error=sso_gangguan` (FE menampilkan "Layanan SSO sedang gangguan") |

### 5.2 Sesi & token

- **Access JWT** RS256, klaim minimum: `sub` (id), `role`, `jti`, `iat`, `exp`. Jangan masukkan NIM/nama/email ke token.
- **Refresh token** acak 256-bit; simpan **hash** (tabel `refresh_token`), rotasi setiap pakai, deteksi *reuse* → cabut seluruh rantai.
- Token dikirim via cookie `httpOnly` → wajib **proteksi CSRF** (double-submit token atau cek header `Origin` + `SameSite`).
- `POST /auth/logout` mencabut refresh token. "Pemulihan akses" (FR-MHS-01): untuk mahasiswa dilakukan via IdP kampus (lupa password kampus); untuk staf via alur reset password berbasis email.

### 5.3 Staf (Psikolog & Dosen Admin)

- `POST /auth/staff/login` {email, password, otp?}. Akun psikolog baru berstatus `MENUNGGU_VERIFIKASI` → **ditolak** sampai Dosen Admin mengaktifkan (use case "Login Akun Staf", alt 4.a).
- Password: `argon2id`; kebijakan panjang ≥ 12; lockout bertahap setelah gagal berulang; **MFA TOTP sangat disarankan** untuk Psikolog dan Dosen Admin karena mengakses data sensitif (tambahan dari tim — tidak ada di proposal, ditandai sebagai rekomendasi).

---

## 6. Verifikasi Mahasiswa Aktif (PBI-02) — SCRUM-210

```ts
interface AkademikClient {
  cekStatus(nim: string): Promise<{ aktif: boolean; sumber: 'api' | 'cache' }>;
}
```

- Dipanggil saat login **dan** periodik (mis. maksimum sekali per 24 jam per akun, dicache di Redis `akademik:{nim}`).
- Timeout 3 dtk; bila API akademik gagal: **kebijakan fail-closed untuk akun baru** (belum pernah terverifikasi → tolak), **fail-open terbatas untuk akun yang sudah terverifikasi** dalam 24 jam terakhir. Karena Genta adalah fitur keselamatan, jangan memblokir mahasiswa yang sedang butuh bantuan hanya karena API akademik down — catat sebagai keputusan yang perlu disetujui PO.
- Tidak aktif → `403 AKUN_TIDAK_AKTIF` (use case alt 3.a). Pembatasan sebagian ("dibatasi aksesnya", FR-MHS-02) sebaiknya mengizinkan **Direktori Sumber Daya** dan info hotline tetap terbuka.
- ⚠️ **Dependensi eksternal:** spesifikasi endpoint API akademik belum ada di proposal. Mulai dengan `MockAkademikClient` (WireMock) dan minta dokumentasi resmi ke pihak kampus di minggu pertama.

### Implementasi PBI-02 saat ini

- `AkademikClient` tersedia melalui `AkademikModule`: `mock` untuk pengembangan dan `http` untuk integrasi REST.
- Mode HTTP memanggil `AKADEMIK_STATUS_URL?nim=...` dengan bearer token dan mengharapkan JSON `{ "aktif": boolean }`; batas waktu 3 detik. Format ini asumsi sementara sampai kontrak resmi API kampus diterima.
- Cache Redis `akademik:{nim}` berlaku 24 jam. Saat cache/API gagal, akun aktif hanya boleh memakai hasil DB jika `terakhir_verifikasi_at` masih berumur maksimal 24 jam. Akun baru gagal tertutup dengan 503 bila tak dapat diverifikasi.
- Status diperiksa saat callback SSO dan pada akses mahasiswa setelah verifikasi terakhir kedaluwarsa. Status tidak aktif dibalas `403 AKUN_TIDAK_AKTIF`; refresh token juga ditolak oleh pemeriksaan status akun.
- Untuk simulasi lokal, set `AKADEMIK_MODE=mock` dan masukkan NIM yang aktif dalam `AKADEMIK_MOCK_ACTIVE_NIMS` (pisahkan dengan koma). Produksi wajib `AKADEMIK_MODE=http`.

---

## 7. RBAC (PBI-04) — SCRUM-215

```ts
@Controller('psikolog/sos')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PSIKOLOG)
export class SosPsikologController { ... }
```

Matriks akses (turunan Tabel 3.4 proposal):

| Sumber daya | Mahasiswa | Psikolog | Dosen Admin |
|-------------|-----------|----------|-------------|
| Profil & data pribadi sendiri | CRUD (milik sendiri) | R/U profil sendiri | R/U profil sendiri |
| Kontak darurat | CRUD (milik sendiri) | — | — |
| `log_sos` | C (buat), R (milik sendiri) | R/U (kasus yang diambil / antrean) | **Hanya agregat** |
| Lokasi SOS | — | R (jika diizinkan mahasiswa; **dicatat di audit**) | ✗ |
| `sesi_konseling` (jadwal) | C/R/U/batal milik sendiri | R/U sesi miliknya | ✗ |
| Ringkasan sesi | ✗ (tidak diwajibkan, opsional baca milik sendiri) | C/R/U **hanya jika `consent_catatan`** | ✗ |
| Riwayat sesi mahasiswa | R milik sendiri | R untuk mahasiswa yang **pernah ditangani** | ✗ |
| `curhat_anonim` | C/R milik sendiri | R via **view tanpa identitas**, C balasan | ✗ |
| `hasil_cek_mandiri` | C/R/D milik sendiri | ✗ (kecuali kebijakan rujukan disetujui) | **Hanya agregat** |
| Circle (telusuri/gabung) | C (gabung), R | R/U untuk Circle yang didampingi + moderasi | CRUD + setujui pembentukan |
| `sumber_daya` | R | R (read-only) | CRUD |
| Akun psikolog, jadwal jaga, konfigurasi SOS | ✗ | R jadwal jaga sendiri | CRUD |
| `audit_log` | ✗ | ✗ | R |
| Master data (kategori minat, template kuesioner) | R | R | CRUD |

Tiga lapis penegakan (jangan hanya satu):

1. **Guard** peran pada controller.
2. **Pemeriksaan kepemilikan** di service (`WHERE id_mahasiswa = :userId` — jangan percaya ID dari body/URL).
3. **View/role database** untuk kasus anonim (`v_curhat_untuk_psikolog`) dan laporan (`denger_report` hanya `SELECT` pada `v_laporan_*`).

---

## 8. Katalog Endpoint

Prefix `/api/v1`. Semua endpoint (kecuali auth publik dan direktori jika dibuka) butuh JWT. Format error: `{ "kode": "SESI_BENTROK", "pesan": "...", "detail": {...} }`.

### 8.1 Auth & Akun — PBI-01, 03

| Method | Path | Peran | Keterangan |
|--------|------|-------|------------|
| GET | `/auth/sso/login` | publik | Redirect ke IdP |
| GET/POST | `/auth/sso/callback` | publik | Selesaikan SSO, terbitkan sesi |
| POST | `/auth/staff/login` | publik | Login psikolog/dosen admin |
| POST | `/auth/refresh` · `/auth/logout` | semua | Rotasi/cabut token |
| GET | `/auth/me` | semua | Identitas & peran |
| GET · PATCH | `/me` | Mhs | Profil |
| GET | `/me/export` | Mhs | Ekspor data milik sendiri (JSON) |
| DELETE | `/me` | Mhs | Hapus data (soft delete + anonimisasi, lihat 05-security-privacy.md §7) |
| GET · POST · PATCH · DELETE | `/me/kontak-darurat[/:id]` | Mhs | Kontak darurat |
| PUT | `/me/preferensi-minat` | Mhs | Untuk rekomendasi Circle |
| POST | `/me/kunci-e2ee` | Mhs, Psi | Unggah kunci publik chat |

### 8.2 Genta — PBI-05…09 (detail alur: `06-genta-sos-realtime.md`)

| Method | Path | Peran | Keterangan |
|--------|------|-------|------------|
| POST | `/genta/sos` | Mhs | Buat SOS `{ situasi, lokasi? }` — idempoten (dedupe SOS aktif) |
| PATCH | `/genta/sos/:id/lokasi` | Mhs | Tambahkan lokasi setelah consent (jika awalnya ditolak) |
| GET | `/genta/sos/aktif` | Mhs | Status SOS milik sendiri |
| GET | `/psikolog/sos` | Psi | Antrean, urut `prioritas DESC, waktu ASC`, filter status |
| POST | `/psikolog/sos/:id/ambil` | Psi | **Atomik**; 409 jika sudah diambil |
| PATCH | `/psikolog/sos/:id/status` | Psi | `DITANGANI` / `SELESAI` + catatan |
| GET · PUT | `/admin/konfigurasi-sos` | Adm | Durasi eskalasi, hotline |
| CRUD | `/admin/penerima-eskalasi` | Adm | Daftar penerima |

### 8.3 Staf & Jadwal Jaga — PBI-09 (FR-ADM-02)

| Method | Path | Peran |
|--------|------|-------|
| GET · POST | `/admin/psikolog` | Adm |
| PATCH | `/admin/psikolog/:id` | Adm |
| POST | `/admin/psikolog/:id/aktifkan` · `/nonaktifkan` | Adm |
| GET · POST · PATCH · DELETE | `/admin/jadwal-jaga[/:id]` | Adm |
| GET | `/psikolog/jadwal-jaga` | Psi (milik sendiri) |

Sinkronisasi `psikolog.status_jaga`: job per menit yang menyetel `status_jaga` berdasarkan `jadwal_jaga` aktif. **Ini harus selesai sebelum PBI-07** (notifikasi butuh tahu "psikolog yang bertugas").

### 8.4 Booking & Sesi — PBI-10…14

| Method | Path | Peran | Keterangan |
|--------|------|-------|------------|
| GET | `/psikolog` | Mhs | Daftar psikolog yang dapat dibooking |
| GET | `/psikolog/:id/slot?tanggal=YYYY-MM-DD` | Mhs | Slot tersedia |
| POST | `/booking` | Mhs | `{ id_psikolog, waktu_mulai, tipe_sesi, keluhan_awal }` → 201 / 409 `SESI_BENTROK` + `alternatif[]` |
| GET | `/booking` · `/booking/:id` | Mhs | Milik sendiri |
| PATCH | `/booking/:id/jadwal` | Mhs | Ubah jadwal (validasi ulang) |
| POST | `/booking/:id/batal` | Mhs | Status → `DIBATALKAN` |
| POST | `/booking/:id/consent-catatan` | Mhs | `{ setuju: boolean }` |
| GET | `/psikolog/sesi` | Psi | Jadwal sesi sendiri |
| PATCH | `/psikolog/sesi/:id/status` | Psi | `BERLANGSUNG`/`SELESAI`/`TIDAK_HADIR` |
| PUT | `/psikolog/sesi/:id/ringkasan` | Psi | **403 `CONSENT_BELUM_ADA`** bila belum consent |
| GET | `/psikolog/riwayat?mahasiswa=` | Psi | Hanya mahasiswa yang pernah ditangani |
| WS | namespace `/sesi` | Mhs, Psi | Chat E2EE + signaling WebRTC |

Anti-bentrok bekerja **dua lapis**: pengecekan di service (untuk pesan error + saran alternatif) dan *exclusion constraint* di DB (jaminan akhir dari race condition) — tangkap error `23P01` → 409.

Slot alternatif (use case 5.b): kembalikan 3–5 slot terdekat psikolog yang sama; bila kosong, psikolog lain di rentang waktu yang sama.

### 8.5 Cek Mandiri, Curhat, Circle, Direktori — PBI-15…19

| Method | Path | Peran | Keterangan |
|--------|------|-------|------------|
| GET | `/cek-mandiri/template` | Mhs | Template PHQ-9 + GAD-7 aktif |
| POST | `/cek-mandiri` | Mhs | Kirim jawaban → skor, tingkat, rekomendasi |
| GET | `/cek-mandiri/riwayat` | Mhs | Milik sendiri |
| POST · GET | `/curhat` | Mhs | Kirim / lihat curhat & balasan sendiri |
| GET | `/psikolog/curhat` | Psi | Dari `v_curhat_untuk_psikolog` (tanpa identitas) |
| POST | `/psikolog/curhat/:id/balasan` | Psi | Saran |
| GET | `/circles?kategori=` · `/circles/:id` | Mhs | Telusuri |
| GET | `/circles/rekomendasi` | Mhs | FR-MHS-07 |
| POST | `/circles/:id/gabung` · `/keluar` | Mhs | 409 `CIRCLE_PENUH` bila kuota habis |
| POST | `/circles` | Mhs | Ajukan pembentukan (status `DIAJUKAN`) |
| GET · POST | `/circles/:id/pesan` (+ WS `/circle`) | Anggota, Psi | Ruang interaksi |
| GET | `/psikolog/circles` | Psi | Circle yang didampingi |
| POST | `/psikolog/circles/:id/pesan/:pid/moderasi` | Psi | Sembunyikan + alasan |
| GET | `/admin/circles?status=DIAJUKAN` | Adm | |
| POST | `/admin/circles/:id/setujui` `{ id_psikolog }` · `/tolak` | Adm | |
| GET | `/sumber-daya` · `/sumber-daya/:id` | Semua | Direktori |
| CRUD | `/admin/sumber-daya` | Adm | |

### 8.6 Admin: Laporan, Master Data, Audit — PBI-20, 21

| Method | Path | Peran |
|--------|------|-------|
| GET | `/admin/laporan/ringkasan?dari=&sampai=` | Adm |
| GET | `/admin/laporan/genta` · `/cek-mandiri` · `/circle` | Adm |
| CRUD | `/admin/kategori-minat` | Adm |
| CRUD | `/admin/template-kuesioner` | Adm |
| GET | `/admin/audit-log?aktor=&aksi=&dari=&sampai=` | Adm |

---

## 9. Logika Domain Penting

### 9.1 Cek Mandiri (FR-MHS-08)

- Skor dihitung **di server** (jangan percaya skor dari klien).
- PHQ-9: 9 butir × 0–3 → total 0–27. GAD-7: 7 butir × 0–3 → total 0–21.
- Pita keparahan standar — PHQ-9: 0–4 minimal, 5–9 ringan, 10–14 sedang, 15–19 sedang-berat, 20–27 berat. GAD-7: 0–4 minimal, 5–9 ringan, 10–14 sedang, 15–21 berat.
- **PHQ-9 butir 9** (pikiran menyakiti diri) bernilai > 0 → set `butir9_positif = true` dan respons API menyertakan `jalur_bantuan_segera: true` (FE menampilkan Genta + hotline secara menonjol). Ini praktik keselamatan standar pada skrining; tetap **bukan diagnosis**.
- Respons selalu memuat teks bahwa hasil bukan diagnosis (pascakondisi use case).
- Gunakan terjemahan Indonesia yang tervalidasi (verifikasi sumbernya) dan simpan di `template_kuesioner.butir` (versi) sehingga FR-ADM-07 dapat memperbarui tanpa deploy.
- Rekomendasi berbasis aturan: ringan → Cek ulang/Circle; sedang → Booking Konseling; berat atau butir 9 → Booking prioritas + Genta + hotline.

### 9.2 Curhat Anonim (FR-MHS-09, FR-PSI-05)

- Saat kirim: buat `alias_anonim` (mis. `Anonim-` + 4 hex dari HMAC(id_mahasiswa, secret)) agar psikolog bisa melanjutkan percakapan tanpa melihat identitas.
- API psikolog **hanya** membaca `v_curhat_untuk_psikolog`. Pengguna DB aplikasi tetap bisa join — maka anonimitas ini *anonimitas terhadap pengguna lain*, bukan terhadap sistem (sesuai catatan Bab 4.3 proposal). Komunikasikan jujur di UI.
- Bila terdeteksi kata kunci risiko tinggi (opsional, fase lanjut), tampilkan jalur bantuan ke mahasiswa; **jangan** mengungkap identitas otomatis tanpa kebijakan & consent yang disetujui — keputusan etik untuk PO + psikolog.

### 9.3 Circle (FR-MHS-06/07, FR-PSI-06, FR-ADM-07)

- Gabung: transaksi dengan `SELECT ... FOR UPDATE` pada baris `circle` + hitung anggota < `kuota`; gagal → `CIRCLE_PENUH`.
- `kuota` 5–8 (constraint DB).
- Pembentukan: Mahasiswa mengajukan → `DIAJUKAN` → Admin menyetujui dengan menetapkan `id_psikolog` pendamping → `AKTIF`.
- Rekomendasi (PBI-18): skor sederhana `bobot_minat_cocok + bobot_sisa_kuota + bobot_aktivitas`; mulai rule-based, tidak perlu ML.
- Alias per Circle bersifat tetap selama keanggotaan; `status_anonim = true` default.

### 9.4 Pengingat Sesi (PBI-14, FR-MHS-11)

- Saat booking dibuat/diubah: jadwalkan baris `pengingat_sesi` (mis. H-24 jam dan H-1 jam). Idempotensi dijamin PK `(id_sesi, offset_menit)`.
- Worker mengirim in-app (`notifikasi`) + email; gagal → retry eksponensial maks 3 kali (use case alt 2.a).
- Sesi diubah/dibatalkan → hapus/atur ulang pengingat.
- Isi email/SMS **tidak** memuat topik keluhan.

### 9.5 Laporan Agregat (FR-ADM-04)

- Dibaca dari `v_laporan_*` oleh role DB `denger_report`.
- Sel dengan jumlah < 5 disembunyikan (k-anonymity sederhana) agar admin tidak bisa mengidentifikasi individu dari angka kecil.
- Tidak ada endpoint laporan yang menerima `id_mahasiswa`.

---

## 10. Enkripsi Aplikasi & Audit (lintas modul)

### EncryptionService (SCRUM-206)

```ts
// format blob: [1B versi][1B panjang keyId][keyId][12B IV][ciphertext][16B auth tag]
encrypt(plain: Buffer | string, aad?: string): Buffer   // AES-256-GCM, IV acak per operasi
decrypt(blob: Buffer, aad?: string): Buffer
```

- `aad` (additional authenticated data) = `tabel:kolom:id_baris` supaya ciphertext tidak bisa dipindah antar baris.
- Rotasi kunci: kunci baru dipakai untuk tulis; kunci lama tetap untuk baca; job *re-encrypt* bertahap.
- Gunakan `TypeORM` `ValueTransformer` atau repository wrapper agar developer tidak lupa mengenkripsi.
- Uji unit: round-trip, tamper → gagal, rotasi kunci.

### Audit (PBI-21) — SCRUM-277

Dekorator `@Audit({ aksi: 'SESI_RINGKASAN_READ', resource: 'sesi_konseling' })` + interceptor. Wajib mencatat (minimum):

`SOS_LOKASI_READ`, `SOS_AMBIL`, `SESI_RINGKASAN_CREATE/READ/UPDATE`, `RIWAYAT_SESI_READ`, `CURHAT_READ`, `CURHAT_BALAS`, `CIRCLE_MODERASI`, `CIRCLE_SETUJUI/TOLAK`, `AKUN_PSIKOLOG_*`, `KONFIGURASI_SOS_UBAH`, `LOGIN_GAGAL`, `AKSES_DITOLAK` (403), `DATA_EKSPOR`, `DATA_HAPUS`.

Log **tidak** berisi isi data — hanya siapa, apa, kapan, dari mana, hasil.

---

## 11. Integrasi Eksternal (KT-08)

| Integrasi | Antarmuka | Mock lokal | Catatan |
|-----------|-----------|------------|---------|
| SSO kampus | `SsoStrategy` | Keycloak | Konfirmasi OIDC vs SAML, nama atribut NIM |
| Sistem akademik | `AkademikClient` | WireMock | Minta spesifikasi + kredensial lebih awal |
| SMS gateway | `SmsProvider.kirim(nomor, teks, idempotencyKey)` | `ConsoleSms` | Retry + catat ke `log_eskalasi`; nomor di log di-*mask* |
| Peta | Browser Geolocation API menghasilkan koordinat; **Maps API hanya untuk menampilkan peta/reverse-geocode di dashboard psikolog** | OSM/Leaflet | Klarifikasi KT-08: koordinat tidak berasal dari "API peta" |
| Hotline 119 ext. 8 (Healing119.id) | Ditampilkan sebagai info + tautan `tel:` | — | Lihat catatan di bawah |

> **Catatan Healing119 / 119 ext. 8:** ini jalur **telepon**. SMS Gateway tidak bisa "memberitahu" hotline tersebut. Subtask SCRUM-235 menyebut integrasi ke kontak darurat *dan* hotline 119 ext. 8 — rekomendasi: (a) SMS ke kontak darurat & penerima eskalasi, (b) tampilkan/klik-telepon 119 ext. 8 ke mahasiswa dan psikolog, (c) tandai `eskalasi_119` + log `INFO_HOTLINE`. Jika diinginkan integrasi langsung ke layanan tersebut, perlu perjanjian/API resmi dari pengelolanya — konfirmasikan sebelum menjanjikan.

---

## 12. Rate Limiting & Anti-Abuse

| Endpoint | Batas awal (usulan) |
|----------|--------------------|
| Global | 100 req/menit/IP |
| `/auth/*` | 10 req/menit/IP + lockout |
| `POST /genta/sos` | Dedupe: SOS aktif < 10 menit dikembalikan, bukan dibuat ulang; maks 5/jam/akun |
| `POST /curhat` | 10/jam/akun |
| `/cek-mandiri` | 20/hari/akun |

---

## 13. Testing Backend

| Tingkat | Cakupan wajib |
|---------|---------------|
| Unit | Skor PHQ-9/GAD-7 (batas pita), EncryptionService, logika slot/bentrok, scoring rekomendasi Circle, RBAC guard |
| Integrasi (Testcontainers) | Migrasi bersih dari nol; constraint DB (bentrok, consent, audit append-only); ambil SOS atomik (dua klien paralel → satu menang) |
| E2E (Supertest) | Alur per PBI sesuai use case di proposal; RBAC lintas peran (SCRUM-221) |
| Non-fungsional | Latensi notifikasi SOS < 5 dtk; load test (lihat `07-testing-qa.md`) |

Target cakupan awal: ≥ 80 % pada `common/` dan modul `genta`, `booking`, `sesi`, `cek-mandiri`.

---

## 14. Definition of Done (Backend)

- [ ] Endpoint terdokumentasi di Swagger (DTO + contoh respons + kode error).
- [ ] Guard peran + pemeriksaan kepemilikan + test akses terlarang.
- [ ] Data sensitif dienkripsi dan **tidak** muncul di log.
- [ ] Aksi sensitif tercatat di audit log.
- [ ] Migrasi maju & mundur teruji; tidak merusak data staging.
- [ ] Unit + integrasi lulus di CI; tidak ada secret ter-commit.
- [ ] Subtask `[QA-Integrasi]` terkait bisa dijalankan di staging.
