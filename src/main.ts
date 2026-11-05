import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  // Loaded after .env, because the modules read process.env while they are being defined.
  const { AppModule } = await import('./app.module');
  const { configureApp } = await import('./app.setup');
  const { AppConfig } = await import('./common/config');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(app.get(AppConfig).port);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
