import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { ValidationException } from '@beauclick/http';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  app.use(helmet());

  // Cookie parsing lives in AppModule's `configure()`, NOT here -- see the
  // note there. Registering it in bootstrap meant the test harness, which
  // never runs bootstrap, silently had no cookie support.

  // CORS: the frontend (apps/web) is a separate origin from the API, so
  // browser calls are cross-origin and require this. Deliberately an
  // explicit ALLOW-LIST from configuration, never `origin: true` /
  // wildcard -- a wildcard would let any site on the internet drive this
  // API with a user's browser. `credentials: true` is now load-bearing
  // rather than forward-looking: the refresh cookie is only sent, and only
  // accepted, on a credentialed cross-origin request, and the spec forbids
  // pairing that with a wildcard origin at all.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3100')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-CSRF-Token is the double-submit header the refresh route requires.
    // A cross-origin attacker cannot set it without this allow-list naming it,
    // which is half of why the double-submit check works.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Label', 'X-CSRF-Token'],
  });

  // Backend foundation requirement: API versioning -- every controller
  // route is already declared as 'v1/...' (ADR-014's URI-based, per-module
  // independent versioning); this prefix completes /api/v1/... to match
  // V3_API_CONTRACT_BLUEPRINT.md's documented paths exactly.
  app.setGlobalPrefix('api');

  // Backend foundation requirement: validation pipeline. whitelist strips
  // unknown fields (never trust an unexpected client-supplied field);
  // forbidNonWhitelisted rejects the request outright rather than silently
  // dropping fields a caller might expect to matter.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new ValidationException(errors),
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  Logger.log(`BeauClick V3 API listening on :${port}`, 'Bootstrap');
}

bootstrap();
