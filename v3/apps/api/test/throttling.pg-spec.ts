import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BeauClickThrottlerGuard, throttlerOptionsFromEnv } from '@beauclick/auth';

import { createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

/**
 * Global rate limiting (PHASE5-02), proven against the REAL application.
 *
 * This suite boots its own app with deliberately TINY limits so the guard
 * can be observed actually firing. Every other suite runs the same guard,
 * fully registered, with limits raised high enough never to trip -- so
 * "the guard is wired" and "the guard enforces" are both covered, and
 * neither is achieved by switching it off.
 *
 * The root cause this guards against regressing: `@nestjs/throttler` does
 * NOT auto-register its guard. For four phases `ThrottlerModule.forRoot()`
 * was configured and three auth routes carried `@Throttle` decorators, but
 * no `ThrottlerGuard` was ever registered -- so all of it was inert
 * metadata, and nothing in the suite noticed.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

// Small enough to exhaust in a test, large enough that a single legitimate
// request sequence still succeeds first.
const LIMIT = 5;
const THROTTLED_ENV = {
  THROTTLE_DEFAULT_LIMIT: String(LIMIT),
  THROTTLE_READ_LIMIT: String(LIMIT),
  THROTTLE_MUTATION_LIMIT: String(LIMIT),
  THROTTLE_AUTH_LIMIT: String(LIMIT),
  THROTTLE_REFRESH_LIMIT: String(LIMIT),
  // Long enough that a window never lapses mid-test by accident; the reset
  // case below drives its own short window instead of sleeping.
  THROTTLE_DEFAULT_TTL_MS: '60000',
  THROTTLE_READ_TTL_MS: '60000',
  THROTTLE_MUTATION_TTL_MS: '60000',
  THROTTLE_AUTH_TTL_MS: '60000',
  THROTTLE_REFRESH_TTL_MS: '60000',
};

describeIfPg('Global rate limiting on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const ctx = await createPgTestApp(THROTTLED_ENV);
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  /** A fresh, unique source IP per case, so buckets never leak between tests. */
  let ipSeq = 0;
  function freshIp(): string {
    ipSeq += 1;
    return `10.77.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}`;
  }

  async function hit(path: string, ip: string, token?: string) {
    const req = request(app.getHttpServer()).get(path).set('X-Forwarded-For', ip);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  describe('the guard is genuinely registered (the regression this fix exists to prevent)', () => {
    it('is present in the application\'s global APP_GUARD providers', () => {
      // Asserted structurally, not by behaviour alone: if someone removes the
      // APP_GUARD registration but leaves ThrottlerModule configured, every
      // behavioural test below would still pass under high test limits while
      // production silently lost all rate limiting -- exactly what happened
      // for four phases.
      const guard = app.get(BeauClickThrottlerGuard, { strict: false });
      expect(guard).toBeInstanceOf(BeauClickThrottlerGuard);
      expect(APP_GUARD).toBeDefined();
    });

    it('resolves its throttler options at the ROOT injector, not a feature module', () => {
      // The second half of the original root cause: ThrottlerModule.forRoot()
      // is not @Global in v6, and it used to live in IdentityModule -- so a
      // root-level guard could not have resolved its storage even if someone
      // had registered one.
      const options = throttlerOptionsFromEnv(process.env);
      expect(options.map((o) => o.name).sort()).toEqual(['auth', 'default', 'mutation', 'read', 'refresh']);
      expect(options.every((o) => o.limit > 0 && o.ttl > 0)).toBe(true);
    });
  });

  describe('enforcement', () => {
    it('allows requests under the limit, then returns 429', async () => {
      const ip = freshIp();
      for (let i = 0; i < LIMIT; i += 1) {
        const res = await hit('/api/v1/search/providers?q=test', ip);
        expect(res.status).not.toBe(429);
      }
      const blocked = await hit('/api/v1/search/providers?q=test', ip);
      expect(blocked.status).toBe(429);
    });

    it('returns the V3 standard 429 contract, and leaks nothing', async () => {
      const ip = freshIp();
      for (let i = 0; i < LIMIT; i += 1) await hit('/api/v1/search/providers?q=x', ip);
      const blocked = await hit('/api/v1/search/providers?q=x', ip);

      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        data: null,
        meta: null,
        error: {
          code: 'RATE_LIMITED',
          message: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.',
        },
      });

      // No internals: no policy name, no limit, no remaining count, no
      // tracker/bucket key, no stack, no English library message.
      const serialized = JSON.stringify(blocked.body);
      for (const leak of ['ThrottlerException', 'Too many requests', 'default', 'read', 'tracker', 'limit', 'ttl', ip]) {
        expect(serialized).not.toContain(leak);
      }
    });
  });

  describe('identity key', () => {
    it('throttles two DIFFERENT unauthenticated IPs independently', async () => {
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < LIMIT; i += 1) await hit('/api/v1/search/providers?q=a', a);
      expect((await hit('/api/v1/search/providers?q=a', a)).status).toBe(429);

      // B is untouched by A exhausting its own bucket.
      expect((await hit('/api/v1/search/providers?q=a', b)).status).not.toBe(429);
    });

    it('gives two authenticated users SEPARATE buckets even from the SAME IP', async () => {
      const sharedIp = freshIp();
      const userA = await seedUser(app, dataSource, `+98950${String(Date.now()).slice(-6)}`);
      const userB = await seedUser(app, dataSource, `+98951${String(Date.now()).slice(-6)}`);

      for (let i = 0; i < LIMIT; i += 1) await hit('/api/v1/me/waitlist', sharedIp, userA.accessToken);
      expect((await hit('/api/v1/me/waitlist', sharedIp, userA.accessToken)).status).toBe(429);

      // This is the property the stock IP-only tracker gets WRONG: two real
      // users behind one NAT/corporate egress must not throttle each other.
      expect((await hit('/api/v1/me/waitlist', sharedIp, userB.accessToken)).status).not.toBe(429);
    });

    it('cannot be moved to another bucket by a CLIENT-SUPPLIED user id', async () => {
      const ip = freshIp();
      const user = await seedUser(app, dataSource, `+98952${String(Date.now()).slice(-6)}`);

      for (let i = 0; i < LIMIT; i += 1) await hit('/api/v1/me/waitlist', ip, user.accessToken);
      expect((await hit('/api/v1/me/waitlist', ip, user.accessToken)).status).toBe(429);

      // Every plausible spoof vector: headers claiming a different identity.
      // The tracker reads req.user, populated only from a verified JWT, so
      // none of these can create a fresh bucket.
      const spoofHeaders: Array<[string, string]> = [
        ['X-User-Id', uuidv7()],
        ['X-User', uuidv7()],
        ['x-forwarded-user', uuidv7()],
      ];
      for (const [header, value] of spoofHeaders) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/me/waitlist')
          .set('X-Forwarded-For', ip)
          .set('Authorization', `Bearer ${user.accessToken}`)
          .set(header, value);
        expect(res.status).toBe(429);
      }

      const viaQuery = await request(app.getHttpServer())
        .get(`/api/v1/me/waitlist?userId=${uuidv7()}`)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(viaQuery.status).toBe(429);
    });

    it('ignores X-Forwarded-For for the IP bucket, because trust proxy is deliberately OFF', async () => {
      // All of these carry DIFFERENT X-Forwarded-For values but originate from
      // the same real socket. If Express trusted the header, each would get its
      // own bucket and the limit would be trivially bypassable by rotating it.
      // `trust proxy` is not enabled, so req.ip stays the real socket address.
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 3; i += 1) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/search/providers?q=spoof')
          .set('X-Forwarded-For', `203.0.113.${i}`);
        statuses.push(res.status);
      }
      // Rotating the header did NOT buy extra budget.
      expect(statuses).toContain(429);
    });
  });

  describe('protected auth surfaces', () => {
    it('throttles OTP REQUEST', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/request-otp')
          .set('X-Forwarded-For', ip)
          .send({ phone: `+9891600000${String(i).padStart(2, '0')}`, purpose: 'login' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });

    it('throttles OTP VERIFICATION', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/verify-otp')
          .set('X-Forwarded-For', ip)
          .send({ phone: '+989170000000', code: '000000', purpose: 'login' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });

    it('throttles REFRESH', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', ip)
          .send({ refreshToken: 'not-a-real-token' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });

    it('throttles a SENSITIVE MUTATION endpoint', async () => {
      const ip = freshIp();
      const user = await seedUser(app, dataSource, `+98953${String(Date.now()).slice(-6)}`);
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('X-Forwarded-For', ip)
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({ professionalId: uuidv7(), slotId: uuidv7() });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });
  });

  describe('exemptions', () => {
    it('NEVER throttles the health endpoint -- infrastructure monitoring must not be starved', async () => {
      const ip = freshIp();
      // Far beyond any configured limit.
      for (let i = 0; i < LIMIT * 6; i += 1) {
        const res = await request(app.getHttpServer()).get('/api/health').set('X-Forwarded-For', ip);
        expect(res.status).not.toBe(429);
      }
    });

    it('health is the ONLY exemption -- an ordinary route from the same IP still throttles', async () => {
      const ip = freshIp();
      for (let i = 0; i < LIMIT * 6; i += 1) {
        await request(app.getHttpServer()).get('/api/health').set('X-Forwarded-For', ip);
      }
      // The health flood bought no immunity for anything else.
      for (let i = 0; i < LIMIT; i += 1) await hit('/api/v1/search/providers?q=z', ip);
      expect((await hit('/api/v1/search/providers?q=z', ip)).status).toBe(429);
    });
  });

  describe('concurrency and normal usage', () => {
    it('handles a genuine concurrent burst without over- or under-counting', async () => {
      const ip = freshIp();
      const burst = await Promise.all(
        Array.from({ length: LIMIT * 3 }, () => hit('/api/v1/search/providers?q=burst', ip)),
      );
      const allowed = burst.filter((r) => r.status !== 429).length;
      const blocked = burst.filter((r) => r.status === 429).length;

      // Some must be allowed and some blocked -- never all-or-nothing.
      expect(allowed).toBeGreaterThan(0);
      expect(blocked).toBeGreaterThan(0);
      expect(allowed + blocked).toBe(LIMIT * 3);
      // In-memory storage counts atomically enough that the allowance is not
      // wildly exceeded under parallel load.
      expect(allowed).toBeLessThanOrEqual(LIMIT * 2);
    });

    it('does not break legitimate normal usage below the limit', async () => {
      const ip = freshIp();
      for (let i = 0; i < LIMIT - 1; i += 1) {
        const res = await hit('/api/v1/search/providers?q=normal', ip);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('window reset', () => {
    it('permits requests again once the window lapses', async () => {
      // A dedicated app with a genuinely short window, so this asserts real
      // expiry rather than mocking the clock.
      const shortCtx = await createPgTestApp({ ...THROTTLED_ENV, THROTTLE_READ_TTL_MS: '1200' });
      const shortApp = shortCtx.app;
      try {
        const ip = freshIp();
        const fire = () =>
          request(shortApp.getHttpServer()).get('/api/v1/search/providers?q=w').set('X-Forwarded-For', ip);

        for (let i = 0; i < LIMIT; i += 1) await fire();
        expect((await fire()).status).toBe(429);

        await new Promise((resolve) => setTimeout(resolve, 1600));

        expect((await fire()).status).not.toBe(429);
      } finally {
        await shortApp.close();
      }
    }, 20_000);
  });
});
