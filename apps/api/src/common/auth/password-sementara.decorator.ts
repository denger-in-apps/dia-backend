import { SetMetadata } from '@nestjs/common';

export const IZINKAN_PASSWORD_SEMENTARA = 'auth:izinkanPasswordSementara';

/**
 * Endpoint yang tetap boleh diakses staf berpassword sementara (`wajib_ganti_password`).
 * Selain endpoint ini, guard membalas `403 PASSWORD_WAJIB_DIGANTI` sampai password diganti.
 */
export const IzinkanPasswordSementara = () => SetMetadata(IZINKAN_PASSWORD_SEMENTARA, true);
