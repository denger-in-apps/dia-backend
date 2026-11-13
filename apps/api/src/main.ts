import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cookieParser = require('cookie-parser');
import { configureApp } from './app.setup';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import { validasiEnv } from './common/config/validasi-env';

async function bootstrap() {
  // Gagal cepat dengan daftar lengkap kesalahan konfigurasi (02-backend.md §4).
  validasiEnv();
  const app = await NestFactory.create(AppModule);
  app.use(helmet({ hsts: process.env.NODE_ENV === 'production' ? undefined : false }));
  app.use(cookieParser());
  configureApp(app);
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins, credentials: true });
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
  if (process.env.REALTIME_REDIS_ADAPTER !== 'false') {
    const ioAdapter = new RedisIoAdapter(app);
    await ioAdapter.connectToRedis();
    app.useWebSocketAdapter(ioAdapter);
  }
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
}
bootstrap();
