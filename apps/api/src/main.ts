import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cookieParser = require('cookie-parser');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet({ hsts: process.env.NODE_ENV === 'production' ? undefined : false }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins, credentials: true });
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
}
bootstrap();
