import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';

import { BeauClickExceptionFilter, ResponseEnvelopeInterceptor, ValidationException } from '@beauclick/http';
import { JwtAuthGuard, CapabilityGuard } from '@beauclick/auth';
import { OwnershipGuard } from '@beauclick/ownership';
import { IdentityModule, IDENTITY_ENTITIES, OTP_DEBUG_OBSERVER, OtpDebugObserver } from '@beauclick/identity';
import { ProviderModule, PROVIDER_ENTITIES } from '@beauclick/provider';
import { createInMemoryDataSource } from '@beauclick/testing';
import { TypeOrmTestingModule } from './typeorm-testing.module';

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

export async function createTestApp(): Promise<TestApp> {
  applyHermeticTestEnv();
  const entities = [...IDENTITY_ENTITIES, ...PROVIDER_ENTITIES];
  // Built and initialized BEFORE the testing module is compiled -- see
  // TypeOrmTestingModule's docblock for why this must be synchronous, not
  // an async dynamic module.
  const dataSource = await createInMemoryDataSource(entities);
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
      IdentityModule,
      ProviderModule,
    ],
    providers: [
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
  return { app, otpObserver };
}

export function getTestDataSource(app: INestApplication): DataSource {
  return app.get<DataSource>(getDataSourceToken());
}
