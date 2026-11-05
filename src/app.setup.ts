import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { ServerOptions } from 'socket.io';
import { AppConfig } from './common/config';
import { AllExceptionsFilter, validation } from './common/errors';

class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins } });
  }
}

/** Field names of every failed rule, nested ones as "supervisor.name". */
export function fieldNames(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const name = prefix ? `${prefix}.${e.property}` : e.property;
    return e.children?.length ? fieldNames(e.children, name) : [name];
  });
}

/** Everything the app needs around its routes. main.ts and the tests both use this, so tests run the real stack. */
export function configureApp(app: NestExpressApplication) {
  const config = app.get(AppConfig);

  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.trustProxy);
  app.useBodyParser('json', { limit: '1mb' });

  const secure = helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } });
  // The API returns JSON, so its content security policy only matters to the docs page, which needs inline scripts.
  const docs = helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/api/docs') ? docs : secure)(req, res, next));

  app.enableCors({ origin: config.corsOrigins, exposedHeaders: ['Content-Disposition'] });
  app.useWebSocketAdapter(new CorsIoAdapter(app, config.corsOrigins));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { exposeUnsetFields: false },
      exceptionFactory: (errors) => validation(fieldNames(errors)),
    }),
  );

  const doc = new DocumentBuilder()
    .setTitle('NU Volunteer API')
    .setDescription('เอกสารฉบับเต็มอยู่ที่ docs/API-CONTRACT.md')
    .setVersion('1.0')
    .addBearerAuth()
    .addSecurityRequirements('bearer')
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));
}
