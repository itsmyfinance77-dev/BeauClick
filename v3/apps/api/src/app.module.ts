import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { ThrottlerModule } from '@nestjs/throttler';

import { BeauClickExceptionFilter, ResponseEnvelopeInterceptor } from '@beauclick/http';
import {
  BeauClickThrottlerGuard,
  JwtAuthGuard,
  CapabilityGuard,
  throttlerOptionsFromEnv,
} from '@beauclick/auth';
import { OwnershipGuard } from '@beauclick/ownership';
import { IdentityModule, IDENTITY_ENTITIES } from '@beauclick/identity';
import { ProviderModule, PROVIDER_ENTITIES } from '@beauclick/provider';
import { BOOKING_ENTITIES } from '@beauclick/booking';
import { COMMERCE_ENTITIES } from '@beauclick/commerce';
import { PAYMENT_ENTITIES } from '@beauclick/payment';
import { SEARCH_ENTITIES } from '@beauclick/search';
import { LOYALTY_ENTITIES } from '@beauclick/loyalty';
import { JOURNEY_ENTITIES } from '@beauclick/journey';
import { NOTIFICATION_ENTITIES } from '@beauclick/notification';
import { ANALYTICS_ENTITIES } from '@beauclick/analytics';
import { BUSINESS_ENTITIES } from '@beauclick/business';
import { WAITLIST_ENTITIES } from '@beauclick/waitlist';
import { EventContractsModule } from '@beauclick/event-contracts';
import { AuditModule, AUDIT_ENTITIES } from '@beauclick/audit';
import { MediaModule, MEDIA_ENTITIES } from '@beauclick/media';
import { SubjectDataModule } from '@beauclick/subject-data';
import { HttpMetricsMiddleware, ObservabilityModule } from '@beauclick/observability';
import { PRIVACY_ENTITIES } from '@beauclick/privacy';
import { AI_ENTITIES } from '@beauclick/ai';
import { CHAT_ENTITIES } from '@beauclick/chat';
import { WISHLIST_ENTITIES } from '@beauclick/wishlist';
import { REFERRAL_ENTITIES } from '@beauclick/referral';
import { COMMERCIAL_ENTITIES } from '@beauclick/commercial-policy';
import { DomainCompositionModule } from './composition/domain-composition.module';
import { PrivilegedCapabilityModule } from './composition/privileged-capability.module';
import { PrivacyCompositionModule } from './composition/privacy-composition.module';

import cookieParser from 'cookie-parser';
import { CorrelationMiddleware } from './observability/correlation.middleware';

import { validateEnv } from './config/env.validation';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { MetricsController } from './observability/metrics.controller';

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
        entities: [
          ...IDENTITY_ENTITIES,
          ...PROVIDER_ENTITIES,
          ...BOOKING_ENTITIES,
          ...COMMERCE_ENTITIES,
          ...PAYMENT_ENTITIES,
          // Phase 3. financial's remain deliberately absent -- they live on a
          // separate DataSource connected as the append-only role (ADR-017),
          // and registering them here would give this shared pool a live
          // handle on the ledger.
          ...SEARCH_ENTITIES,
          ...LOYALTY_ENTITIES,
          ...JOURNEY_ENTITIES,
          ...NOTIFICATION_ENTITIES,
          ...ANALYTICS_ENTITIES,
          // Phase 4. Both are ordinary application-role tables on this SAME
          // shared pool -- neither needs financial's isolation treatment.
          ...BUSINESS_ENTITIES,
          ...WAITLIST_ENTITIES,
          // The administrative audit log. On the MAIN DataSource deliberately:
          // the application role holds INSERT + SELECT on it and nothing else,
          // so a single pool is both sufficient and safe -- unlike `financial`,
          // where the role cannot even SELECT and a second pool is unavoidable.
          // Sharing the pool is what lets an audit row commit in the same
          // transaction as the mutation it records.
          ...AUDIT_ENTITIES,
          // V3.1 Phase C. Ordinary application-role tables on the shared pool:
          // `media.objects` is an authorization record the application both
          // reads and writes on every upload, so it needs neither `financial`'s
          // second DataSource nor `admin`'s owner-role isolation.
          ...MEDIA_ENTITIES,
          // V3.1 Phase E. `privacy.data_requests` and `privacy.export_payloads`
          // are ordinary application-role tables on the shared pool: privacy
          // orchestrates other modules' erasures inside ONE transaction on this
          // DataSource, which it could not do from an isolated connection.
          ...PRIVACY_ENTITIES,
          // V3.2-A. Six ordinary application-role tables on the shared pool.
          // The AI schema needs neither `financial`'s second DataSource nor
          // `admin`'s owner-role isolation: the application both reads and
          // writes every one of them, and the sensitivity of what they hold is
          // answered by there being no route that reads another customer's row
          // (`V32-DEC-009`) rather than by a connection-level grant.
          ...AI_ENTITIES,
          // V3.2-B. Seven ordinary application-role tables on the shared pool.
          // Chat holds the platform's second store of private subject-authored
          // prose, and like `ai`'s the sensitivity is answered by there being no
          // route that reads another party's rows -- not by a connection-level
          // grant.
          ...CHAT_ENTITIES,
          // V3.2-C Story #8. One ordinary application-role table on the shared
          // pool. Registering it HERE and not only through
          // `TypeOrmModule.forFeature` is what makes it exist at all:
          // `forFeature` registers a repository PROVIDER, and a repository for
          // an entity the DataSource has no metadata for fails at request time
          // with `No metadata for "WishlistSavedItemEntity" was found` -- a 500
          // that looks like a query bug rather than like a missing registration.
          ...WISHLIST_ENTITIES,
          // V3.2-C Story #11. One ordinary application-role table on the shared
          // pool. Registered HERE and not only through
          // `TypeOrmModule.forFeature` for the reason the wishlist line above
          // records: `forFeature` registers a repository PROVIDER, and a
          // repository for an entity the DataSource has no metadata for fails at
          // REQUEST time with `No metadata for "ReferralCodeEntity" was found` --
          // a 500 that looks like a query bug while the app boots cleanly.
          ...REFERRAL_ENTITIES,
          // V3.3-A Story #40 (`#40a`). Five ordinary application-role tables on
          // the shared pool. This is an ENTITLEMENT catalogue and not the money
          // ledger (ADR-041 §11), so it needs neither `financial`'s second
          // DataSource nor `admin`'s owner-role isolation -- the immutability it
          // needs comes from triggers on rows the application owns, and the
          // application must be able to publish a draft, which the append-only
          // financial role correctly cannot do for anything.
          //
          // Registered HERE and not only through `TypeOrmModule.forFeature` for
          // the reason the wishlist and referral lines above record: `forFeature`
          // registers a repository PROVIDER, and a repository for an entity the
          // DataSource has no metadata for fails at REQUEST time with `No
          // metadata for "CommercialPlanVersionEntity" was found` -- a 500 that
          // looks like a query bug while the app boots cleanly.
          ...COMMERCIAL_ENTITIES,
        ],
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
    /**
     * Rate limiting, configured at the ROOT.
     *
     * Placement is load-bearing, not tidiness: `ThrottlerModule.forRoot()` is
     * not a @Global module in v6, so its ThrottlerStorage/options are only
     * visible to the injector that imports it. It previously lived in
     * IdentityModule, where a root-level APP_GUARD could never have resolved
     * it. Configured through `forRootAsync` so every limit stays
     * environment-tunable (see `throttlerOptionsFromEnv`) -- infrastructure
     * must be able to retune under real traffic without a code change.
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Read from process.env rather than ConfigService.get: the throttler
      // options are plain data, and this keeps one source of truth with the
      // pure `throttlerOptionsFromEnv` the tests exercise directly.
      useFactory: () => throttlerOptionsFromEnv(),
    }),
    // Global: every event producer validates against it on the way into
    // its own outbox, and no domain may import another to obtain it.
    EventContractsModule,
    // Global, so every module that registers a privileged mutation can write
    // its audit record without importing anything -- and so the boot-time
    // assertion has a home that does not depend on which modules a given
    // composition happens to include.
    AuditModule,
    // Global, so every module that needs the live privileged-capability
    // re-check can reach it -- see that module's note on why an AppModule
    // provider was not enough.
    PrivilegedCapabilityModule,
    // V3.1 Phase C. Imported at the root for the same reason AuditModule is:
    // it is infrastructure several domains reference (provider today; privacy
    // exports and, eventually, review imagery next), and the driver choice is
    // one boot-time decision the whole application shares. Not `@Global()`,
    // though -- a module that needs `MediaService` imports it and says so.
    MediaModule,
    // V3.1 Phase F. `@Global()`, for the reason AuditModule records: metrics
    // and error reporting are infrastructure several domains reference, and
    // requiring each one to import them would mean the ones that should count
    // something quietly do not.
    ObservabilityModule,
    // Global, so the boot-time subject-data coverage assertion is reachable
    // from the composition that knows the full contract list -- the same
    // reasoning AuditModule records for its own enforcement service.
    SubjectDataModule,
    IdentityModule,
    ProviderModule,
    // V3.2-A's `AiCompositionModule` is reached THROUGH this one rather than
    // listed here, exactly as `Phase3CompositionModule` is: it contributes an
    // outbox source that `DomainCompositionModule`'s merged `OUTBOX_SOURCES`
    // factory injects, and a token is resolved through the injector of the
    // module declaring the consumer -- so being a sibling here would not have
    // been enough. It still loads before `PrivacyCompositionModule` below, which
    // is what the coverage assertion needs.
    DomainCompositionModule,
    // V3.1 Phase E. Imported AFTER DomainCompositionModule so the boot-order
    // is the honest one: every domain module is instantiated before the
    // coverage assertion runs over the contracts they registered.
    PrivacyCompositionModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    // V3.1 Phase F. Declared at the ROOT because that is the only injector
    // that can see every module's exports at once -- the readiness report has
    // to reach the payment registry, the search engine, the SMS provider, and
    // the financial DataSource, which live in four different modules. Each is
    // injected `@Optional()`, so a composition that omits one reports it as
    // `not_configured` rather than refusing to boot: a health surface that can
    // take the process down is worse than no health surface.
    ReadinessService,
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
    // Throttling runs AFTER JwtAuthGuard, deliberately. It keys on the
    // authenticated user id when there is one, and `req.user` only exists
    // once JwtAuthGuard has verified the token -- registered before it,
    // every authenticated request would silently fall back to a shared IP
    // bucket, which is precisely the bug this ordering avoids. Unauthenticated
    // and @Public() routes still reach it and are keyed by IP.
    { provide: APP_GUARD, useClass: BeauClickThrottlerGuard },
    // The privileged re-check's implementation now lives in
    // `PrivilegedCapabilityModule` (imported above and `@Global()`), because a
    // provider declared HERE is invisible to every imported module -- which
    // silently denied `MediaService` the verifier it needs to authorize a
    // protected download. Same binding, same fail-closed behaviour, one scope
    // wider.
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_GUARD, useClass: OwnershipGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * Cookie parsing is registered HERE rather than in `main.ts`.
   *
   * It was in `main.ts` first, and that was a real bug: the test harness boots
   * the application through `Test.createTestingModule`, which never runs
   * `bootstrap()`. So `req.cookies` was undefined under test, every
   * cookie-authenticated refresh silently fell through to the body path, and
   * the CSRF check -- which only applies to the cookie path -- was never
   * exercised at all. The suite passed while the mechanism was untested.
   *
   * Middleware that the application's behaviour depends on belongs to the
   * module, so every consumer of AppModule gets it identically.
   */
  configure(consumer: MiddlewareConsumer): void {
    // Order matters. Metrics FIRST, so a request that fails in correlation or
    // cookie parsing is still counted -- and, more importantly, so are the
    // ones that never reach a controller at all. `HttpMetricsMiddleware`
    // records why it cannot be an interceptor: a guard rejection (401, 403,
    // 429) and an unmatched route (404) both bypass every interceptor, which
    // would leave an error-rate dashboard reporting zero of exactly the
    // failures it exists to surface.
    //
    // Correlation next, so anything that fails inside cookie parsing is still
    // traceable and still gets the response header.
    consumer.apply(HttpMetricsMiddleware, CorrelationMiddleware, cookieParser()).forRoutes('*');
  }
}
