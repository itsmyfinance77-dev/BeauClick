import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { ValidationException } from '@beauclick/http';
import { assertPrivilegedMutationsAreAudited } from '@beauclick/audit';
import { OTP_DEBUG_OBSERVER, OtpDebugObserver, capabilitiesForRoles } from '@beauclick/identity';
import { CHAT_CLOCK, ChatClock } from '@beauclick/chat';
import { OutboxRelay } from '@beauclick/events';
import { FINANCIAL_DATA_SOURCE } from '@beauclick/financial';


export const TEST_JWT_SECRET = 'pg-test-secret-do-not-use-in-real-environments';

/**
 * Boots the REAL application against the REAL PostgreSQL server.
 *
 * Why this exists alongside `test-app.factory.ts` (the pg-mem one): pg-mem
 * does not honour TypeORM's ROLLBACK -- a row written inside a transaction
 * that throws survives it (verified directly in the Phase 2 pass). Every
 * guarantee Phase 2 rests on is transactional or concurrency-related:
 * the atomic slot claim, booking+order atomicity, payment verification's
 * compare-and-swap, the ledger's grant-enforced immutability. **None of them
 * can be proved on the fast layer.** They are proved here or nowhere.
 *
 * Nothing is substituted. Same modules, same guards, same filters, same
 * migrations-created schema, same append-only financial role. Only the
 * background sweep timers are disabled, so tests drive expiry and outbox
 * draining explicitly instead of racing a wall clock.
 */
export interface PgTestApp {
  app: INestApplication;
  dataSource: DataSource;
  financialDataSource: DataSource;
  relay: OutboxRelay;
  /**
   * Observes generated OTP codes.
   *
   * The ONLY way a test can learn a code: `OtpService` never returns, logs, or
   * persists a plaintext one, and the stored value is an HMAC. That is the
   * property under test as much as it is an inconvenience -- V2's own
   * `otp_generated` hook existed for exactly this reason and for no other.
   */
  otpObserver: CapturingOtpObserver;
  /**
   * The chat module's clock, frozen on demand.
   *
   * `chat.send_counters` buckets by wall-clock UTC minute, so a burst that
   * straddles :59 -> :00 is charged to two buckets and the cap appears not to
   * hold. That is correct production behaviour and a flaky test: the twenty-first
   * send is refused 55 seconds out of 60. Freezing removes the coin flip without
   * changing what is being proved -- the limit still has to be enforced by the
   * conditional write, not by the test.
   *
   * Left running by default, so a spec that does not care sees real time.
   */
  chatClock: FreezableChatClock;
}

/** Real time until a test says otherwise. */
export class FreezableChatClock implements ChatClock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }

  /** Pins the clock. With no argument, pins it to now. */
  freeze(at: Date = new Date()): Date {
    this.fixed = new Date(at.getTime());
    return this.now();
  }

  release(): void {
    this.fixed = null;
  }
}

export class CapturingOtpObserver implements OtpDebugObserver {
  private readonly codesByPhone = new Map<string, string>();

  onCodeGenerated(phone: string, code: string): void {
    this.codesByPhone.set(phone, code);
  }

  lastCodeFor(phone: string): string {
    const code = this.codesByPhone.get(phone);
    if (!code) throw new Error(`No OTP code was captured for ${phone} -- did requestOtp run first?`);
    return code;
  }
}

const HERMETIC_ENV: Record<string, string> = {
  JWT_ACCESS_SECRET: TEST_JWT_SECRET,
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: '30',
  OTP_HMAC_SECRET: 'pg-test-otp-secret',
  OTP_EXPIRY_SECONDS: '120',
  OTP_MAX_ATTEMPTS: '5',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_PER_PHONE_PER_HOUR: '1000',
  OTP_MAX_PER_IP_PER_HOUR: '1000',
  PAYMENT_DEFAULT_PROVIDER: 'sandbox',
  PAYMENT_INTENT_TTL_MINUTES: '30',
  PAYMENT_ENVIRONMENT: 'sandbox',
  PAYMENT_SANDBOX_CHECKOUT_URL: 'http://localhost:3100/sandbox-gateway',
  FINANCIAL_COMMISSION_RATE_BP: '1500',
  BOOKING_HOLD_MINUTES: '15',
  BOOKING_MAX_CONCURRENT_HOLDS: '5',
  BOOKING_MAX_RESCHEDULES: '2',
  BOOKING_RESCHEDULE_MIN_HOURS_BEFORE: '6',
  PUBLIC_API_BASE_URL: 'http://localhost:3099/api',
  PUBLIC_WEB_BASE_URL: 'http://localhost:3100',
  // Timers off: a test must drive expiry and outbox draining deliberately.
  // A background sweep firing mid-assertion is a flaky test, not coverage.
  DISABLE_BACKGROUND_SWEEPS: 'true',
  NODE_ENV: 'test',
  /**
   * V3.2-A. The AI policy numbers, pinned to the owner-decided values.
   *
   * Set explicitly rather than left to the code defaults for the reason the
   * loyalty block below records: a case asserting that the twenty-first message
   * is refused must be testing the QUOTA MECHANISM, not whatever
   * `AI_DAILY_MESSAGE_QUOTA` happens to fall back to. A suite that needs a
   * different boundary overrides it through `createPgTestApp`'s parameter,
   * which is the documented seam.
   *
   * `AI_DEFAULT_PROVIDER` is deliberately UNSET: exactly one provider is
   * registered, so the registry resolves it without guessing -- and leaving it
   * unset is what exercises that path rather than the configured one.
   */
  AI_DAILY_MESSAGE_QUOTA: '20',
  AI_MAX_RETAINED_CONVERSATIONS: '20',
  AI_INACTIVITY_CLOSE_HOURS: '24',
  AI_RETENTION_DAYS: '30',
  AI_PROVIDER_TIMEOUT_MS: '5000',
  /**
   * V3.2-B. The chat policy numbers, pinned to the owner-decided values.
   *
   * Set explicitly rather than left to the code defaults for the reason the
   * loyalty and AI blocks record: a case asserting that the 21st message in a
   * minute is refused must be testing the THROTTLE MECHANISM, not whatever
   * default happens to be current.
   */
  CHAT_MAX_MESSAGES_PER_MINUTE: '20',
  CHAT_MAX_MESSAGES_PER_DAY: '300',
  CHAT_MAX_REPORTS_PER_DAY: '5',
  CHAT_RETENTION_MONTHS: '24',
  CHAT_RETENTION_BATCH_SIZE: '500',
  // Loyalty policy pinned so a case asserting a points total is testing the
  // ledger, not whatever GAP-10 default happens to be current.
  LOYALTY_POINTS_BOOKING_COMPLETED: '10',
  LOYALTY_POINTS_ORDER_COMPLETED: '10',
  LOYALTY_POINTS_REVIEW_SUBMITTED: '5',
  LOYALTY_TIER_BASIS: 'lifetime',
  // Left unset unless a spec opts in: without it the search module binds the
  // in-memory engine, which is correct for every case that is not about
  // OpenSearch itself.
  AUTH_COOKIE_SECURE: 'false',
  AUTH_COOKIE_SAMESITE: 'lax',
  // The CSRF policy reads the same allow-list CORS does -- one source of
  // truth for "who may drive this API".
  CORS_ALLOWED_ORIGINS: 'http://localhost:3100',
  /**
   * Media runs on the LOCAL driver in this harness, which is the honest
   * choice: it is a real implementation whose bytes land on a real disk and
   * come back off it, so every content, size, quota, and authorization
   * property is exercised against real behaviour rather than a fake.
   *
   * The S3 driver is verified separately, against a real S3-compatible server
   * (`media-s3.pg-spec.ts`). Two suites because they prove two different
   * things: this one proves the media MODEL, that one proves the PROTOCOL.
   */
  MEDIA_STORAGE_DRIVER: 'local',
  // A throwaway directory outside the repository. The default root is
  // `cwd/.media-store`, which is correct for a developer running the API and
  // wrong for a test suite -- a suite that writes into the working tree leaves
  // artefacts behind and eventually one of them gets committed.
  MEDIA_LOCAL_ROOT: join(tmpdir(), 'beauclick-pg-test-media'),
  MEDIA_UPLOAD_TOKEN_SECRET: 'pg-test-media-upload-secret',
  MEDIA_DOWNLOAD_TOKEN_SECRET: 'pg-test-media-download-secret',
  /**
   * Rate limiting stays FULLY ACTIVE in tests -- the guard is registered and
   * runs on every request here exactly as it does in production. Only the
   * LIMITS differ, raised high enough that a suite firing hundreds of
   * requests from one IP never trips them.
   *
   * Deliberately not `DISABLE_THROTTLING=true`: an off switch would mean the
   * entire suite proves nothing about whether the guard is wired at all,
   * which is the precise failure this whole fix exists to correct (the guard
   * was unwired for four phases and no test noticed). `throttling.pg-spec.ts`
   * builds its own app with LOW limits to prove the guard really fires, so
   * both properties are covered: wired everywhere, and enforcing.
   */
  THROTTLE_DEFAULT_LIMIT: '100000',
  THROTTLE_READ_LIMIT: '100000',
  THROTTLE_MUTATION_LIMIT: '100000',
  THROTTLE_AUTH_LIMIT: '100000',
  THROTTLE_REFRESH_LIMIT: '100000',
};

export function requiredPgEnv(): { database: string; financial: string } | null {
  const database = process.env.TEST_DATABASE_URL;
  const financial = process.env.TEST_FINANCIAL_WRITER_URL;
  return database && financial ? { database, financial } : null;
}

/**
 * @param envOverrides applied AFTER the hermetic defaults, so a suite can
 * boot the real application under a different configuration -- used by
 * `throttling.pg-spec.ts` to run with deliberately tiny rate limits while
 * every other suite runs with limits high enough never to trip. Because
 * @nestjs/config snapshots the environment at boot, these must be set before
 * the app is created, which is exactly what this parameter guarantees.
 */
export async function createPgTestApp(envOverrides: Record<string, string> = {}): Promise<PgTestApp> {
  const env = requiredPgEnv();
  if (!env) throw new Error('TEST_DATABASE_URL and TEST_FINANCIAL_WRITER_URL are required for the real-Postgres suite');

  // Applied to process.env directly, not only via ConfigModule.load():
  // @nestjs/config consults process.env BEFORE its internal config, and Nx
  // auto-loads apps/api/.env into process.env when running this project's
  // targets. Without this the suite would pass under bare `jest` and fail
  // under `nx run api:test:pg` on identical code -- a real, reproduced
  // Phase 1 failure.
  for (const [key, value] of Object.entries(HERMETIC_ENV)) process.env[key] = value;
  for (const [key, value] of Object.entries(envOverrides)) process.env[key] = value;
  process.env.DATABASE_URL = env.database;
  process.env.FINANCIAL_DATABASE_URL = env.financial;

  /**
   * `AppModule` is imported HERE, after the environment is set, and NOT at the
   * top of this file.
   *
   * `ConfigModule.forRoot({ validate })` runs the moment `app.module.ts` is
   * evaluated -- that is when the `@Module` decorator's `imports` array is
   * constructed, not when `Test.createTestingModule` runs. `validate` receives
   * a snapshot of `process.env` and its return value becomes the module's
   * internal config, which `ConfigService.get()` reads in preference to
   * `process.env`.
   *
   * With a static import that snapshot was taken at FILE LOAD, before this
   * function had assigned anything -- so `envOverrides` silently affected only
   * the values read straight from `process.env` (throttler options) and never
   * the ones read through `ConfigService` (every OTP, booking, loyalty, and
   * privacy policy number).
   *
   * That was invisible until a suite overrode a `ConfigService` value whose
   * `apps/api/.env` entry differed from the code default: under bare `jest` the
   * override appeared to work, because the snapshot fell through to the same
   * default it was asking for, and under `nx run api:test:pg` -- which loads
   * `apps/api/.env` into `process.env` first -- it did not. Same code, two
   * results, which is precisely the failure mode the comment above about
   * `process.env` was written to prevent in the first place.
   *
   * ONE CAVEAT, because it is not obvious: jest caches the module per test
   * FILE, so the snapshot belongs to the FIRST `createPgTestApp` call in a
   * file. A suite that boots a second app with different overrides gets the
   * first app's `ConfigService` values. That is fine for the one suite doing it
   * today (`throttling.pg-spec.ts` overrides only `THROTTLE_*`, which
   * `throttlerOptionsFromEnv` reads straight from `process.env` at boot), and
   * it is written down here so the next suite that needs two configurations
   * splits into two files instead of debugging it.
   */
  const { AppModule } = await import('../src/app.module');

  // AppModule already registers the global filter, interceptor, and the
  // three guards. Re-registering them here (an earlier version did) silently
  // DOUBLE-WRAPPED every response envelope -- data.data.redirectUrl instead
  // of data.redirectUrl -- and ran each guard twice. The harness must boot
  // the application, not rebuild half of it.
  const otpObserver = new CapturingOtpObserver();
  const chatClock = new FreezableChatClock();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    // The first substitution replaces a NO-OP with a recorder, and the second
    // hands a test the ability to stop time -- which the chat clock exists for.
    // Neither bypasses production behaviour: the clock runs at real time unless a
    // test freezes it, and every rule still reads it through the same port.
    .overrideProvider(OTP_DEBUG_OBSERVER)
    .useValue(otpObserver)
    .overrideProvider(CHAT_CLOCK)
    .useValue(chatClock)
    .compile();

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

  // The same structural assertion `main.ts` makes, so an unaudited privileged
  // mutation fails the TEST SUITE as well as the boot. Without this the check
  // would only run in production -- the one place where discovering it is most
  // expensive.
  assertPrivilegedMutationsAreAudited(app);

  return {
    app,
    dataSource: app.get<DataSource>(getDataSourceToken()),
    financialDataSource: app.get<DataSource>(FINANCIAL_DATA_SOURCE),
    relay: app.get(OutboxRelay),
    otpObserver,
    chatClock,
  };
}

/**
 * Tables to clear between cases, children first.
 *
 * financial tables are absent on purpose: the application role cannot delete
 * from them (that is the whole point of ADR-017), and the writer role cannot
 * either. Financial state is cleaned via the OWNER connection in the specs
 * that need it -- which is itself a useful reminder of how locked down the
 * schema really is.
 */
export const RESETTABLE_TABLES = [
  // V3.2-C Story #8. One table, no children, no outbox -- `wishlist` emits no
  // events and has no outbox table at all. Listed first only to keep the
  // newest-schema-first convention this list has followed since Phase 4.
  'wishlist.saved_items',
  // V3.2-B. Children first by convention, though the composite FKs cascade.
  'chat.outbox_events',
  'chat.reports',
  'chat.messages',
  'chat.conversation_participants',
  'chat.conversations',
  'chat.blocks',
  'chat.send_counters',
  // V3.2-A. Children first by convention, though the composite FKs cascade:
  // `ai.recommendations` and `ai.messages` both reference `ai.conversations`
  // ON DELETE CASCADE, so naming them keeps the truncate explicit rather than
  // relying on a cascade to do the right thing -- the same reasoning the
  // `identity.user_roles` line below records.
  'ai.outbox_events',
  'ai.recommendations',
  'ai.messages',
  'ai.conversations',
  'ai.assistant_consents',
  'ai.usage_daily',
  // Phase 4 schemas first, for the same children-first reason Phase 3's
  // comment gives: waitlist entries reference booking/provider ids by
  // convention (no FK), and business staff rows reference identity/provider
  // ids the same way, so clearing them before what they reference is safe
  // regardless of ordering, but keeping the newest-downstream-first
  // convention consistent is what makes this list easy to extend correctly.
  'waitlist.outbox_events',
  'waitlist.entries',
  'business.outbox_events',
  'business.business_staff',
  'business.businesses',
  'analytics.daily_metrics',
  'analytics.rollup_state',
  'analytics.events',
  'notification.outbox_events',
  'notification.preferences',
  'notification.notifications',
  'journey.outbox_events',
  'journey.timeline_entries',
  'journey.beauty_goals',
  'journey.beauty_profiles',
  'loyalty.outbox_events',
  'loyalty.tier_crossings',
  'loyalty.points_entries',
  'loyalty.memberships',
  'loyalty.benefits',
  'loyalty.membership_plans',
  'loyalty.tiers',
  'search.outbox_events',
  'search.signal_applications',
  'search.ranking_signals',
  'search.provider_documents',
  'search.index_state',
  'provider.outbox_events',
  'payment.outbox_events',
  'payment.refunds',
  'payment.payment_attempts',
  'payment.payment_intents',
  'payment.sandbox_transactions',
  'commerce.outbox_events',
  'commerce.order_adjustments',
  'commerce.order_items',
  'commerce.orders',
  'booking.outbox_events',
  'booking.idempotency_keys',
  'booking.booking_history',
  'booking.bookings',
  'booking.availability_slots',
  'provider.professional_specialties',
  'provider.services',
  'provider.professionals',
  'provider.specialties',
  'provider.locations_cities',
  'identity.refresh_tokens',
  'identity.phone_conflicts',
  'identity.otp_requests',
  // user_roles cascades from users, but naming it keeps the truncate explicit
  // rather than relying on a cascade to do the right thing.
  'identity.user_roles',
  'identity.users',
  'provider.verification_requests',
  // V3.1 Phase C. Evidence and portfolio items reference media objects by
  // value, so they are cleared before the objects they point at -- the same
  // children-first convention the rest of this list follows.
  'provider.verification_request_evidence',
  'provider.portfolio_items',
  // V3.1 Phase D. Reviews reference eligibility by FK, so children first --
  // the same convention the rest of this list follows.
  'provider.reviews',
  'provider.review_eligibility',
  'media.abuse_reports',
  'media.objects',
  // V3.1 Phase E. Payloads first: `export_payloads.request_id` is a real FK to
  // `data_requests`, the only cross-table FK in the privacy schema.
  'privacy.outbox_events',
  'privacy.export_payloads',
  'privacy.data_requests',
];

/**
 * The audit log is TRUNCATED SEPARATELY, and cannot be.
 *
 * `admin.admin_audit_log` is owned by a role the application never connects as
 * and the application holds INSERT + SELECT only -- so the test's own
 * TRUNCATE would be refused, exactly as a tampering attempt would. Rows
 * therefore accumulate across cases in a suite run, which is why every
 * assertion in `operability-foundation.pg-spec.ts` filters by `target_id`
 * rather than counting the table.
 *
 * That is the correct trade. Granting the test role DELETE would mean the
 * suite proves immutability against a role that does not have it.
 */

export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(`TRUNCATE ${RESETTABLE_TABLES.join(', ')} CASCADE`);
}

/** Clears the financial schema. Needs the OWNER connection -- neither app nor writer may DELETE. */
export async function resetFinancial(ownerUrl: string): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE financial.settlement_items, financial.settlement_batches, financial.ledger_entries, financial.outbox_events CASCADE',
    );
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Seed helpers -- real rows, through the real schema, no fixtures library.
// ---------------------------------------------------------------------------

export interface SeededUser {
  id: string;
  phone: string;
  roles: string[];
  accessToken: string;
}

export async function seedUser(
  app: INestApplication,
  dataSource: DataSource,
  phone: string,
  roles: string[] = ['customer'],
): Promise<SeededUser> {
  const id = uuidv7();
  await dataSource.query(
    `INSERT INTO identity.users (id, phone, roles, is_verified_professional) VALUES ($1, $2, $3, false)`,
    [id, phone, `{${roles.join(',')}}`],
  );

  // The role ASSIGNMENT rows, not only the denormalized column.
  //
  // Phase A moved authorization's source of truth to `identity.user_roles`
  // (R31-01). This helper writes the user row directly rather than going
  // through AccountResolverService, so without these inserts every seeded user
  // would resolve to zero capabilities -- and every pre-Phase-A test assuming a
  // working customer session would fail for a reason unrelated to what it
  // tests.
  for (const role of roles) {
    await dataSource.query(
      `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
       VALUES ($1, $2, NULL, 'test seed') ON CONFLICT DO NOTHING`,
      [id, role],
    );
  }

  const jwt = app.get(JwtService);
  const accessToken = jwt.sign({ sub: id, roles, capabilities: capabilitiesForRoles(roles) });
  return { id, phone, roles, accessToken };
}

export interface SeededProfessional {
  id: string;
  ownerUserId: string;
  serviceId: string;
  priceToman: number;
}

export async function seedProfessional(
  dataSource: DataSource,
  ownerUserId: string,
  displayName: string,
  priceToman = 200_000,
): Promise<SeededProfessional> {
  const id = uuidv7();
  const serviceId = uuidv7();
  await dataSource.query(
    `INSERT INTO provider.professionals (id, owner_id, display_name, verification_status) VALUES ($1, $2, $3, 'verified')`,
    [id, ownerUserId, displayName],
  );
  await dataSource.query(
    `INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman) VALUES ($1, $2, $3, 60, $4)`,
    [serviceId, id, `${displayName} — خدمت`, priceToman],
  );
  return { id, ownerUserId, serviceId, priceToman };
}

export async function seedSlot(
  dataSource: DataSource,
  professionalId: string,
  serviceId: string | null,
  startAt: Date,
  durationMinutes = 60,
): Promise<string> {
  const id = uuidv7();
  await dataSource.query(
    `INSERT INTO booking.availability_slots (id, professional_id, service_id, start_at, end_at, status)
     VALUES ($1, $2, $3, $4, $5, 'open')`,
    [id, professionalId, serviceId, startAt, new Date(startAt.getTime() + durationMinutes * 60_000)],
  );
  return id;
}

export interface SeededBusiness {
  id: string;
  ownerUserId: string;
}

export async function seedBusiness(dataSource: DataSource, ownerUserId: string, displayName: string): Promise<SeededBusiness> {
  const id = uuidv7();
  await dataSource.query(
    `INSERT INTO business.businesses (id, owner_id, display_name, verification_status) VALUES ($1, $2, $3, 'unverified')`,
    [id, ownerUserId, displayName],
  );
  return { id, ownerUserId };
}

/** A slot far enough ahead to satisfy the reschedule minimum-notice rule. */
export function futureSlotTime(hoursFromNow: number): Date {
  // Aligned to the hour so two seeded slots never accidentally overlap and
  // trip the exclusion constraint.
  const at = new Date(Date.now() + hoursFromNow * 3_600_000);
  at.setUTCMinutes(0, 0, 0);
  return at;
}
