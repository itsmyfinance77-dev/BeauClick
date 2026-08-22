import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { throttlerOptionsFromEnv } from '@beauclick/auth';

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

  /**
   * Clears the throttler's counters between cases.
   *
   * Necessary because every supertest request originates from the SAME real
   * socket (127.0.0.1) and `trust proxy` is deliberately off, so all
   * unauthenticated traffic in this file legitimately shares ONE bucket --
   * see the X-Forwarded-For case below, which proves exactly that and is a
   * security property, not a limitation to work around. Without this reset,
   * the first test to exhaust the bucket would fail every later one.
   *
   * Note this resets STORAGE, never the guard: the guard stays registered
   * and enforcing throughout.
   */
  function resetThrottleCounters(): void {
    const storage = app.get(ThrottlerStorage, { strict: false }) as { storage?: Map<string, unknown> };
    storage?.storage?.clear();
  }

  beforeEach(async () => {
    await resetDatabase(dataSource);
    resetThrottleCounters();
  });

  /**
   * `ip` is accepted and sent as X-Forwarded-For for realism, but it does NOT
   * create a separate bucket -- trust proxy is off, so every request here
   * shares the 127.0.0.1 bucket. Per-case isolation comes from
   * `resetThrottleCounters()`, and per-IDENTITY separation is proven with
   * real authenticated users instead.
   */
  async function hit(path: string, ip: string, token?: string) {
    const req = request(app.getHttpServer()).get(path).set('X-Forwarded-For', ip);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  let ipSeq = 0;
  function freshIp(): string {
    ipSeq += 1;
    return `10.77.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}`;
  }

  describe('the guard is genuinely registered (the regression this fix exists to prevent)', () => {
    it('throttles a route that carries NO @Throttle decorator at all', async () => {
      // THE structural proof that the guard is GLOBAL, expressed as behaviour
      // because that is what actually cannot be faked. `/v1/me/waitlist` opts
      // into nothing -- no @Throttle anywhere on it or its controller -- so it
      // can only be rate-limited by a globally-registered guard applying the
      // `default` policy. If someone deletes the APP_GUARD line, this fails
      // even though every decorated route would keep working.
      //
      // (Asserting via `app.get(BeauClickThrottlerGuard)` was tried and is
      // wrong: guards registered under the APP_GUARD multi-token are not
      // retrievable by their class token, so that assertion failed while the
      // guard was in fact correctly wired.)
      const ip = freshIp();
      const user = await seedUser(app, dataSource, `+98954${String(Date.now()).slice(-6)}`);
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 2; i += 1) {
        statuses.push((await hit('/api/v1/me/waitlist', ip, user.accessToken)).status);
      }
      expect(statuses).toContain(429);
    });

    it('registers EXACTLY ONE throttler -- more than one silently ANDs the limits together', () => {
      // Not a style preference. ThrottlerGuard.canActivate loops over every
      // configured throttler and requires all to pass, so N named throttlers
      // apply N limits to every route and the effective limit becomes their
      // MINIMUM. An earlier design registered five, which would have capped
      // search -- nominally 300/min -- at refresh's 20/min. Per-route limits
      // come from @Throttle(policy(...)) overrides of this single throttler,
      // never from registering more of them.
      const options = throttlerOptionsFromEnv();
      expect(options).toHaveLength(1);
      expect(options[0].name).toBe('default');
      expect(options[0].limit).toBeGreaterThan(0);
      expect(options[0].ttl).toBeGreaterThan(0);
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
    it('keys UNAUTHENTICATED traffic by the real socket address, not a claimed one', async () => {
      // Deliberately NOT "two different IPs get separate buckets": every
      // supertest request comes from the same real socket, and the only way
      // to claim otherwise is X-Forwarded-For, which is correctly ignored
      // (proven below). Simulating distinct IPs would therefore require
      // enabling `trust proxy` in tests -- which would test a configuration
      // production does not have, and would assert the OPPOSITE of the
      // security property that actually holds.
      //
      // What IS provable and matters: unauthenticated traffic shares one
      // bucket per real source, and it is genuinely enforced.
      const ip = freshIp();
      for (let i = 0; i < LIMIT; i += 1) {
        expect((await hit('/api/v1/search/providers?q=a', ip)).status).not.toBe(429);
      }
      expect((await hit('/api/v1/search/providers?q=a', ip)).status).toBe(429);
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
      // `allSettled`, not `all`: supertest spins up an ephemeral server per
      // request, and a large simultaneous fan-out can drop a connection
      // (ECONNRESET) for reasons that have nothing to do with throttling. A
      // dropped connection must not be scored as either allowed or blocked,
      // or the test measures the harness rather than the guard.
      const settled = await Promise.allSettled(
        Array.from({ length: LIMIT * 2 }, () => hit('/api/v1/search/providers?q=burst', ip)),
      );
      const statuses: number[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') statuses.push(outcome.value.status);
      }

      const allowed = statuses.filter((s) => s !== 429).length;
      const blocked = statuses.filter((s) => s === 429).length;

      // The property under test: under a genuine parallel burst the guard
      // neither lets everything through nor blocks everything, and never
      // allows more than the configured budget.
      expect(statuses.length).toBeGreaterThan(LIMIT);
      expect(allowed).toBeGreaterThan(0);
      expect(blocked).toBeGreaterThan(0);
      expect(allowed).toBeLessThanOrEqual(LIMIT);
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
      // A dedicated app with a genuinely short window, so this asserts REAL
      // expiry against a real clock rather than mocking time.
      const ttlMs = 1000;
      // BOTH the read override and the default must be shortened. With a
      // single registered throttler the `default` ttl is what
      // ThrottlerModule was configured with at boot; the `read` override only
      // changes what the search route resolves per request. Shortening just
      // one leaves the other still blocking -- which is exactly how the
      // five-throttler design was caught.
      const shortCtx = await createPgTestApp({
        ...THROTTLED_ENV,
        THROTTLE_READ_TTL_MS: String(ttlMs),
        THROTTLE_DEFAULT_TTL_MS: String(ttlMs),
      });
      const shortApp = shortCtx.app;
      try {
        const ip = freshIp();
        const fire = () =>
          request(shortApp.getHttpServer()).get('/api/v1/search/providers?q=w').set('X-Forwarded-For', ip);

        for (let i = 0; i < LIMIT; i += 1) await fire();
        expect((await fire()).status).toBe(429);

        // Generous margin, deliberately. Two separate timers must lapse, not
        // one: `blockDuration` defaults to `ttl` in v6, so exceeding the limit
        // starts a block that runs from the moment of blocking, ON TOP of the
        // per-hit decay timers. An earlier version waited only 1.3x the ttl
        // and flaked in CI for exactly that reason.
        await new Promise((resolve) => setTimeout(resolve, ttlMs * 3.5));

        expect((await fire()).status).not.toBe(429);
      } finally {
        await shortApp.close();
      }
    }, 30_000);
  });
});
