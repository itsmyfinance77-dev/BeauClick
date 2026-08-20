import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { BeauClickExceptionFilter, ResponseEnvelopeInterceptor } from '@beauclick/http';
import { JwtAuthGuard, CapabilityGuard } from '@beauclick/auth';
import { OwnershipGuard } from '@beauclick/ownership';
import { IdentityModule, IDENTITY_ENTITIES } from '@beauclick/identity';
import { ProviderModule, PROVIDER_ENTITIES } from '@beauclick/provider';
import { BOOKING_ENTITIES } from '@beauclick/booking';
import { COMMERCE_ENTITIES } from '@beauclick/commerce';
import { PAYMENT_ENTITIES } from '@beauclick/payment';
import { DomainCompositionModule } from './composition/domain-composition.module';

import { validateEnv } from './config/env.validation';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      // See BeauClickJwtModule's identical note (libs/auth/src/jwt-config.module.ts):
      // a registerAsync/forRootAsync dynamic module needs ConfigModule in
      // its OWN imports to resolve `inject: [ConfigService]`, even though
      // ConfigModule is global -- the standard NestJS/@nestjs/config fix.
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get('DATABASE_URL') ?? 'postgres://beauclick:beauclick@localhost:5432/beauclick',
        // financial's entities are deliberately ABSENT from this list. They
        // live on a separate DataSource connected as the append-only role
        // (ADR-017); registering them here would give this pool -- the one
        // every controller and guard shares -- a live handle on the ledger.
        entities: [...IDENTITY_ENTITIES, ...PROVIDER_ENTITIES, ...BOOKING_ENTITIES, ...COMMERCE_ENTITIES, ...PAYMENT_ENTITIES],
        // V3_DATABASE_BLUEPRINT.md §2 mandates lower_snake_case columns;
        // TypeORM's default naming strategy uses the JS property name
        // verbatim (camelCase) instead. Without this, TypeORM generates
        // queries against columns like "createdAt" that do not exist in
        // the real, hand-written migration schema (which is snake_case,
        // e.g. created_at) -- a real bug found during Phase 1 completion's
        // live-Postgres verification (pg-mem's synchronize:true had always
        // generated ITS OWN camelCase schema in tests, so this divergence
        // was invisible until the actual migration SQL was run against a
        // real server and the app pointed at it with synchronize:false).
        namingStrategy: new SnakeNamingStrategy(),
        // Phase 1 dev/test convenience ONLY -- V3_DATABASE_BLUEPRINT.md §3
        // mandates real migrations (see database/migrations/) for anything
        // resembling production. synchronize is fine for boot-in-dev
        // convenience but must never be relied on beyond Phase 1.
        // Phase 2 turns this OFF everywhere. Phase 1 allowed it for
        // dev-boot convenience, but the Phase 2 schemas carry partial unique
        // indexes, exclusion constraints, and CHECK constraints that TypeORM's
        // metadata cannot express -- so a synchronize-generated schema would
        // silently DROP the very invariants the correctness of booking and
        // payment rests on. Real migrations are now the only way this schema
        // is created (database/scripts/migrate.ts).
        synchronize: false,
      }),
    }),
    // JwtModule is imported again here (identical config to
    // BeauClickJwtModule) so JwtAuthGuard's JwtService dependency resolves
    // at the app-module level, not only inside IdentityModule's own scope
    // -- global guards need their dependencies available at the root
    // injector.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_ACCESS_SECRET') ?? 'dev-only-insecure-secret-override-in-env',
        signOptions: { expiresIn: config.get('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
    IdentityModule,
    ProviderModule,
    DomainCompositionModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: BeauClickExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // Order matters: Jwt populates req.user first, then Capability checks
    // req.user.capabilities, then Ownership resolves the real resource
    // owner and compares against req.user.userId.
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
      inject: [JwtService, Reflector],
    },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_GUARD, useClass: OwnershipGuard },
  ],
})
export class AppModule {}
