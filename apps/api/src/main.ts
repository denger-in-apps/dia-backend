import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();
  
  const port = process.env.PORT || 3000;
  await app.listen(port);
}
bootstrap();
