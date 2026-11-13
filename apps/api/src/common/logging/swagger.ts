import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Swagger aktif bila bukan produksi, kecuali diatur eksplisit `SWAGGER_AKTIF` (02-backend.md §2). */
export function swaggerAktif(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SWAGGER_AKTIF === 'false') return false;
  if (env.SWAGGER_AKTIF === 'true') return true;
  return env.NODE_ENV !== 'production';
}

/** OpenAPI 3 di `/api/docs` (UI) dan `/api/docs-json` (FE men-generate tipe klien). */
export function pasangSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Denger.in API')
    .setDescription('API backend Denger.in. Prefix /api/v1; Bearer access token dari /auth/*.')
    .setVersion('1')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json' });
}
