import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { ValidationException } from '@beauclick/http';
import { capabilitiesForRoles } from '@beauclick/identity';
import { OutboxRelay } from '@beauclick/events';
import { FINANCIAL_DATA_SOURCE } from '@beauclick/financial';

import { AppModule } from '../src/app.module';

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
  PAYMENT_DEFAULT_PROVIDER: 'mock',
  PAYMENT_INTENT_TTL_MINUTES: '30',
  PAYMENT_MOCK_CHECKOUT_URL: 'http://localhost:3100/mock-gateway',
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
};

export function requiredPgEnv(): { database: string; financial: string } | null {
  const database = process.env.TEST_DATABASE_URL;
  const financial = process.env.TEST_FINANCIAL_WRITER_URL;
  return database && financial ? { database, financial } : null;
}

export async function createPgTestApp(): Promise<PgTestApp> {
  const env = requiredPgEnv();
  if (!env) throw new Error('TEST_DATABASE_URL and TEST_FINANCIAL_WRITER_URL are required for the real-Postgres suite');

  // Applied to process.env directly, not only via ConfigModule.load():
  // @nestjs/config consults process.env BEFORE its internal config, and Nx
  // auto-loads apps/api/.env into process.env when running this project's
  // targets. Without this the suite would pass under bare `jest` and fail
  // under `nx run api:test:pg` on identical code -- a real, reproduced
  // Phase 1 failure.
  for (const [key, value] of Object.entries(HERMETIC_ENV)) process.env[key] = value;
  process.env.DATABASE_URL = env.database;
  process.env.FINANCIAL_DATABASE_URL = env.financial;

  // AppModule already registers the global filter, interceptor, and the
  // three guards. Re-registering them here (an earlier version did) silently
  // DOUBLE-WRAPPED every response envelope -- data.data.redirectUrl instead
  // of data.redirectUrl -- and ran each guard twice. The harness must boot
  // the application, not rebuild half of it.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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

  return {
    app,
    dataSource: app.get<DataSource>(getDataSourceToken()),
    financialDataSource: app.get<DataSource>(FINANCIAL_DATA_SOURCE),
    relay: app.get(OutboxRelay),
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
  'payment.outbox_events',
  'payment.refunds',
  'payment.payment_attempts',
  'payment.payment_intents',
  'payment.mock_gateway_transactions',
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
  'identity.users',
];

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

/** A slot far enough ahead to satisfy the reschedule minimum-notice rule. */
export function futureSlotTime(hoursFromNow: number): Date {
  // Aligned to the hour so two seeded slots never accidentally overlap and
  // trip the exclusion constraint.
  const at = new Date(Date.now() + hoursFromNow * 3_600_000);
  at.setUTCMinutes(0, 0, 0);
  return at;
}
