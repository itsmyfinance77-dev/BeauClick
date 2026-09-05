import { Test } from '@nestjs/testing';
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';

import { BeauClickExceptionFilter, ResponseEnvelopeInterceptor, ValidationException } from '@beauclick/http';
import { JwtAuthGuard, CapabilityGuard } from '@beauclick/auth';
import { OwnershipGuard } from '@beauclick/ownership';
import { IdentityModule, IDENTITY_ENTITIES, OTP_DEBUG_OBSERVER, OtpDebugObserver } from '@beauclick/identity';
import { ProviderModule, PROVIDER_ENTITIES, SELLER_OWNER_ROLE_GRANT } from '@beauclick/provider';
import { CAPABILITIES_BY_ROLE, ROLES } from '@beauclick/identity';
import { PRIVILEGED_CAPABILITIES } from '@beauclick/auth';
import { IdentityBackedOwnerRoleGrant } from '../src/composition/port-adapters';
import { WISHLIST_ENTITIES } from '@beauclick/wishlist';
import { EventContractsModule } from '@beauclick/event-contracts';
import { AuditModule, AUDIT_ENTITIES } from '@beauclick/audit';
import { createInMemoryDataSource } from '@beauclick/testing';
import { TypeOrmTestingModule } from './typeorm-testing.module';
import {
  WishlistPortsModule,
  WishlistSavedStateModule,
} from '../src/composition/wishlist-composition.module';

const TEST_JWT_SECRET = 'test-secret-do-not-use-in-real-environments';

/** Captures generated OTP codes by phone -- the only way a test can ever learn one (see otp-debug-observer.ts: no production/public path exposes it). */
export class CapturingOtpObserver implements OtpDebugObserver {
  private codesByPhone = new Map<string, string>();

  onCodeGenerated(phone: string, code: string): void {
    this.codesByPhone.set(phone, code);
  }

  lastCodeFor(phone: string): string {
    const code = this.codesByPhone.get(phone);
    if (!code) throw new Error(`No OTP code was ever captured for ${phone} -- did requestOtp run first?`);
    return code;
  }
}

/**
 * Builds the real Nest application (same module wiring as AppModule) for
 * e2e/integration tests, with ONE substitution: the Postgres DataSource is
 * backed by pg-mem instead of a real server (this environment has no
 * Docker/local Postgres -- see V3_PHASE1_IMPLEMENTATION.md Known
 * Limitations). Every guard, interceptor, filter, and route runs exactly
 * as it would in production -- only the SQL engine underneath is swapped.
 */
export interface TestApp {
  app: INestApplication;
  otpObserver: CapturingOtpObserver;
  /** The in-memory DataSource, so a test can manipulate stored state directly (e.g. age a timestamp past a grace window). */
  dataSource: DataSource;
}

/**
 * The values every e2e test runs against. Applied directly to process.env
 * (see applyHermeticTestEnv) rather than relying only on ConfigModule's
 * load(), because @nestjs/config's ConfigService.get() consults process.env
 * BEFORE load()'s internal config (config.service.js: getFromProcessEnv is
 * checked at line ~91, getFromInternalConfig only at ~95), and
 * `ignoreEnvVars` does not gate that path. Nx auto-loads a project's own
 * .env (apps/api/.env, used for live verification against real Postgres)
 * into process.env when running that project's targets -- without this,
 * the suite passes under a bare `jest` invocation and fails under
 * `nx run api:test` on identical code, purely from ambient environment.
 * A real, reproduced failure from the Phase 1 completion pass.
 */
const HERMETIC_TEST_ENV: Record<string, string> = {
  JWT_ACCESS_SECRET: TEST_JWT_SECRET,
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: '30',
  /*
   * V3.3-A Story #69. A DEDICATED value, distinct from every other secret in
   * this map — the suite asserts that a shared one is refused in production, so
   * the harness must not itself be an example of the thing being refused.
   *
   * A throwaway literal that exists only in this file. It is not a real secret,
   * it is not the development fallback, and it is never printed.
   */
  WORKSPACE_REFERENCE_HMAC_SECRET: 'fast-test-workspace-reference-secret',
  OTP_HMAC_SECRET: 'test-otp-secret',
  OTP_EXPIRY_SECONDS: '2', // short expiry so expiry tests don't need to sleep long
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_PER_PHONE_PER_HOUR: '5',
  OTP_MAX_PER_IP_PER_HOUR: '1000',
};

function applyHermeticTestEnv(): void {
  for (const [key, value] of Object.entries(HERMETIC_TEST_ENV)) {
    process.env[key] = value;
  }
  // DATABASE_URL must not leak in either -- these tests use the in-memory
  // DataSource exclusively (real-Postgres coverage lives in the separate
  // *.pg-spec.ts suite), and a stray DATABASE_URL would be misleading.
  delete process.env.DATABASE_URL;
}

/**
 * The #75 owner-role port, bound `@Global()` for the pg-mem layer — V3.3
 * `V33-DEC-021`.
 *
 * ## Why a module and not a root-level provider
 *
 * `ProviderService` resolves `SELLER_OWNER_ROLE_GRANT` from `ProviderModule`'s
 * OWN injector. A provider listed in `Test.createTestingModule({ providers })`
 * sits in the root injector, which that module cannot see — so the graph fails
 * to compile with a message that looks like a missing binding rather than a
 * misplaced one. `DomainPortsModule`'s `PRICING_RULES` comment records the same
 * trap costing a silent, money-affecting bug in production.
 *
 * ## The REAL adapter, not a stub
 *
 * `IdentityBackedOwnerRoleGrant` is the same class the composition root binds,
 * and it needs only `RoleService`, which `IdentityModule` provides. A stub that
 * granted nothing would make this layer agree with itself and prove nothing
 * about the wiring — the failure Story #8 shipped and the reason the wishlist
 * ports above are real too.
 */
@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    IdentityBackedOwnerRoleGrant,
    { provide: SELLER_OWNER_ROLE_GRANT, useExisting: IdentityBackedOwnerRoleGrant },
  ],
  exports: [SELLER_OWNER_ROLE_GRANT],
})
class OwnerRoleTestPortsModule {}

/**
 * Seeds `identity.roles`, `identity.capabilities` and `identity.role_capabilities`
 * into the pg-mem DataSource.
 *
 * ## Why this did not exist before, and why it has to now
 *
 * `synchronize: true` creates the TABLES from the entities; it does not run the
 * migrations, so the role catalogue those migrations SEED was empty here.
 * Nothing noticed, because of a second-order accident worth naming:
 * `AccountResolverService.resolveOrCreate` catches every failure of its creation
 * transaction and falls back to reading the row by phone — and pg-mem does not
 * honour ROLLBACK, so the user row written inside the failed transaction
 * survived and was found. Every fast-layer account was therefore created down
 * the CONFLICT path with no roles at all, and every test passed because none of
 * them needed a capability.
 *
 * V3.3 #75 makes that unsustainable: `ProviderService.create` now grants the
 * owner role inside its own transaction, and a missing `professional` row is a
 * `RoleNotFoundException` the route correctly answers `400` to. Seeding is the
 * honest fix — the fast layer should agree with the real schema rather than
 * depend on an accident.
 *
 * ## Seeded FROM the code constant, not from a second copy
 *
 * `ROLES` and `CAPABILITIES_BY_ROLE` are the same values
 * `20260824100001_create_roles_and_capabilities.sql` and its successors seed, and
 * `PRIVILEGED_CAPABILITIES` is the same list the guard and `libs/audit` consult.
 * Transcribing the rows here would create a third copy to keep in step.
 */
async function seedRoleCatalogue(dataSource: DataSource): Promise<void> {
  // The three tiers the migration marks privileged. Kept explicit rather than
  // derived, because "which ROLE is dangerous" is a product decision the data
  // records, not something inferable from its capabilities.
  const privilegedRoles = new Set(['moderator', 'platform_operator', 'administrator']);
  const capabilities = new Set<string>();
  for (const role of ROLES) for (const capability of CAPABILITIES_BY_ROLE[role]) capabilities.add(capability);

  for (const capability of capabilities) {
    await dataSource.query(
      'INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES ($1, $2, $3)',
      [capability, capability, PRIVILEGED_CAPABILITIES.includes(capability)],
    );
  }
  for (const role of ROLES) {
    await dataSource.query(
      'INSERT INTO identity.roles (slug, name, description, is_privileged, is_default) VALUES ($1, $2, $3, $4, $5)',
      [role, role, role, privilegedRoles.has(role), role === 'customer'],
    );
    for (const capability of CAPABILITIES_BY_ROLE[role]) {
      await dataSource.query(
        'INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES ($1, $2)',
        [role, capability],
      );
    }
  }
}

export async function createTestApp(): Promise<TestApp> {
  applyHermeticTestEnv();
  // AUDIT_ENTITIES joins the list because Phase A made an audit record part of
  // a privileged mutation's own transaction -- identity and provider now depend
  // on AdminAuditService, so a module graph without it cannot resolve them.
  // WISHLIST_ENTITIES joins the list for the reason AUDIT_ENTITIES did before
  // it: V3.2-C Story #9 made the caller's saved state part of the public
  // professional shape, so `ProviderController` now depends on a port bound by
  // the REAL composition modules below, and those need the table to exist.
  //
  // The real bindings are imported rather than stubbed deliberately. A stub
  // returning "nothing is saved" would make this layer agree with itself and
  // prove nothing about the wiring — which is precisely the failure Story #8
  // shipped (the entity was missing from the DataSource list, every POST
  // returned 500 at request time, and the app booted cleanly).
  const entities = [...IDENTITY_ENTITIES, ...PROVIDER_ENTITIES, ...AUDIT_ENTITIES, ...WISHLIST_ENTITIES];
  // Built and initialized BEFORE the testing module is compiled -- see
  // TypeOrmTestingModule's docblock for why this must be synchronous, not
  // an async dynamic module.
  const dataSource = await createInMemoryDataSource(entities);
  await seedRoleCatalogue(dataSource);
  const otpObserver = new CapturingOtpObserver();

  const moduleBuilder = Test.createTestingModule({
    imports: [
      // ignoreEnvFile prevents reading a .env from disk; applyHermeticTestEnv()
      // (called above) is what actually guarantees the values, since
      // process.env wins over load() in @nestjs/config -- see its docblock.
      // load() is kept as the declarative record of the same values.
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ ...HERMETIC_TEST_ENV })],
      }),
      TypeOrmTestingModule.forDataSource(dataSource),
      JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }),
      // Global, and required: provider-service now validates every event it
      // produces against the registry on the way into its own outbox.
      EventContractsModule,
      // @Global, but a global module still has to be imported ONCE somewhere in
      // the graph to be registered. This is that once, for the pg-mem layer.
      AuditModule,
      IdentityModule,
      ProviderModule,
      // V3.2-C Story #9. Both are @Global, and both still have to be imported
      // ONCE somewhere in the graph to be registered -- this is that once for
      // the pg-mem layer. `WishlistPortsModule` binds the wishlist's read into
      // the catalogue; `WishlistSavedStateModule` binds the catalogue's read
      // into the wishlist, which is the one `ProviderController` needs.
      WishlistPortsModule,
      WishlistSavedStateModule,
      // V3.3 #75 (`V33-DEC-021`). See the module's own docblock: a provider
      // declared at the testing-module ROOT is not visible inside
      // `ProviderModule`'s own injector, which is the exact trap the
      // `PRICING_RULES` comment in `DomainPortsModule` records.
      OwnerRoleTestPortsModule,
    ],
    providers: [
      /*
       * V3.3 #75 (`V33-DEC-021`). The REAL adapter, not a stub.
       *
       * `ProviderService` requires this port and does not declare an
       * `@Optional()` fallback, so a module graph without it fails to compile --
       * which is the property that makes the binding impossible to forget in
       * production. This layer honours the same rule the WishlistPorts comment
       * above records: a stub that quietly granted nothing would make this
       * factory agree with itself and prove nothing about the wiring.
       *
       * `IdentityBackedOwnerRoleGrant` needs only `RoleService`, which
       * `IdentityModule` above already provides.
       */
      { provide: APP_FILTER, useClass: BeauClickExceptionFilter },
      { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      {
        provide: APP_GUARD,
        useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
        inject: [JwtService, Reflector],
      },
      { provide: APP_GUARD, useClass: CapabilityGuard },
      { provide: APP_GUARD, useClass: OwnershipGuard },
    ],
  }).overrideProvider(OTP_DEBUG_OBSERVER).useValue(otpObserver);

  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new ValidationException(errors),
    }),
  );
  await app.init();
  return { app, otpObserver, dataSource };
}

export function getTestDataSource(app: INestApplication): DataSource {
  return app.get<DataSource>(getDataSourceToken());
}
