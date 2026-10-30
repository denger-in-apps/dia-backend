# PBI-01 [BE] Uji fungsi OIDC dengan mock

Panduan ini menguji fungsi OIDC di aplikasi tanpa menghubungi Identity Provider (IdP) sungguhan. Tidak perlu mengisi credential OIDC di `.env`.

## Yang diuji

Unit test `apps/api/src/common/auth/oidc-sso.strategy.spec.ts` mengganti
`openid-client` dengan mock dan memakai Redis palsu. Test mencakup:

- URL authorization memuat `state`, `nonce`, dan PKCE `S256`; verifier disimpan dengan TTL.
- Callback memberikan `state`, `nonce`, dan PKCE verifier yang diharapkan ke proses penukaran code.
- Klaim mahasiswa dinormalisasi: NIM di-trim dan email dibuat lowercase.
- `state` tidak valid ditolak sebelum mengakses Redis.
- Email yang belum terverifikasi ditolak.
- Penolakan login dari IdP dipetakan sebagai `SsoProviderDeniedException`.

Mock konfigurasi di test (`idp.example.edu`, `prototype-client`, dan
`prototype-secret`) hanya nilai tiruan. `discovery()` dan
`authorizationCodeGrant()` tidak membuat koneksi jaringan.

## Menjalankan test

Dari PowerShell, jalankan:

```powershell
cd apps/api
npm test -- --runInBand common/auth/oidc-sso.strategy.spec.ts
```

Hasil yang diharapkan: suite `OidcSsoStrategy` lulus seluruhnya. Untuk
menjalankan semua unit test pada folder auth:

```powershell
npm test -- --runInBand common/auth
```

Test ini berjalan tanpa Docker, PostgreSQL, Redis, koneksi internet, akun
kampus, maupun nilai OIDC pada `.env`.

## Batas cakupan

Test mock memastikan fungsi aplikasi membentuk authorization request dan
memvalidasi respons/claim sesuai skenario yang ditulis. Test ini **tidak**
membuktikan bahwa issuer, client ID, client secret, redirect URI, konfigurasi
claim, TLS, atau jaringan ke IdP nyata sudah benar. Pengujian integrasi nyata
dilakukan terpisah menggunakan provider dan credential development yang
disiapkan oleh pemiliknya.
