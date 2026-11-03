import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * Konfigurasi aplikasi yang harus identik antara runtime (main.ts) dan test,
 * agar perilaku validasi & prefix route yang diuji sama dengan produksi.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
