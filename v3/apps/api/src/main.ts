import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { ValidationException } from '@beauclick/http';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  app.use(helmet());

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
