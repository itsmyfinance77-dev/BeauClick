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

export async function createTestApp(): Promise<TestApp> {
  const entities = [...IDENTITY_ENTITIES, ...PROVIDER_ENTITIES];
  // Built and initialized BEFORE the testing module is compiled -- see
  // TypeOrmTestingModule's docblock for why this must be synchronous, not
  // an async dynamic module.
  const dataSource = await createInMemoryDataSource(entities);
  const otpObserver = new CapturingOtpObserver();

  const moduleBuilder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            JWT_ACCESS_SECRET: TEST_JWT_SECRET,
            OTP_HMAC_SECRET: 'test-otp-secret',
            OTP_EXPIRY_SECONDS: '2', // short expiry so expiry tests don't need to sleep long
            OTP_MAX_ATTEMPTS: '3',
            OTP_RESEND_COOLDOWN_SECONDS: '0', // disabled for test convenience except in the dedicated cooldown test
            OTP_MAX_PER_PHONE_PER_HOUR: '5',
            OTP_MAX_PER_IP_PER_HOUR: '1000',
          }),
        ],
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
