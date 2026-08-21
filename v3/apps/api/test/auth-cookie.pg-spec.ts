import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH, csrfTokenMatches } from '@beauclick/identity';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

/** The web app's origin, as configured in the CORS allow-list. */
const ALLOWED_ORIGIN = 'http://localhost:3100';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/** Reads one Set-Cookie header by name. */
function cookieHeader(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c: string) => c.startsWith(`${name}=`));
}

function cookieValue(res: request.Response, name: string): string | undefined {
  return cookieHeader(res, name)?.split(';')[0]?.split('=')[1];
}

describePg('authentication — httpOnly refresh cookie and CSRF (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  /** Signs a user in through the real OTP flow, returning the login response. */
  async function login(phone: string): Promise<request.Response> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/request-otp')
      .send({ phone, purpose: 'login' })
      .expect(200);

    // The code is read from the debug observer, which is the only path that
    // exists: OtpService never returns, logs, or persists a plaintext code,
    // and what IS stored is an HMAC over (phone, purpose, code).
    const code = ctx.otpObserver.lastCodeFor(phone);

    return request(app.getHttpServer())
      .post('/api/v1/auth/verify-otp')
      .send({ phone, code, purpose: 'login' })
      .expect(200);
  }

  describe('cookie attributes', () => {
    it('sets the refresh token as an HTTPONLY cookie on login', async () => {
      const res = await login('+989125000001');
      const cookie = cookieHeader(res, REFRESH_COOKIE_NAME);

      expect(cookie).toBeDefined();
      // The whole point: a single XSS can make requests as the user, but
      // cannot exfiltrate a 30-day credential to use from elsewhere.
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      // Scoped to the auth routes only -- every request that does not need a
      // credential is a request that cannot leak one.
      expect(cookie).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    });

    it('sets the CSRF cookie WITHOUT httpOnly, because the client must read it', async () => {
      const res = await login('+989125000002');
      const cookie = cookieHeader(res, CSRF_COOKIE_NAME);

      expect(cookie).toBeDefined();
      // Safe precisely because the token authenticates nothing on its own --
      // it only proves the caller can read same-origin cookies.
      expect(cookie).not.toMatch(/HttpOnly/i);
    });

    it('returns the CSRF token in the body too, so a client need not parse document.cookie', async () => {
      const res = await login('+989125000003');
      expect(res.body.data.csrfToken).toBeTruthy();
      expect(res.body.data.csrfToken).toBe(cookieValue(res, CSRF_COOKIE_NAME));
    });

    it('still returns an access token in the body, for in-MEMORY storage', async () => {
      const res = await login('+989125000004');
      // Deliberately NOT a cookie: a cookie is sent ambiently on every request
      // to the origin, which is exactly what makes CSRF possible. Held in
      // memory and sent as an explicit Authorization header, a cross-site
      // request cannot carry it at all.
      expect(res.body.data.accessToken).toBeTruthy();
      expect(cookieHeader(res, 'bc_access')).toBeUndefined();
    });
  });

  describe('refresh via cookie', () => {
    it('refreshes using ONLY the cookie and the CSRF header — no body token', async () => {
      const loginRes = await login('+989125000005');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', csrf)
        .send({})
        .expect(200);

      expect(res.body.data.accessToken).toBeTruthy();
      // This is what makes a page reload no longer sign the user out -- the
      // Phase 2 limitation this closes.
      expect(cookieValue(res, REFRESH_COOKIE_NAME)).toBeTruthy();
    });

    it('ROTATES the cookie on every refresh', async () => {
      const loginRes = await login('+989125000006');
      const first = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${first}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', csrf)
        .send({})
        .expect(200);

      // The old token is revoked by rotate(), so leaving a stale cookie in
      // place would make the NEXT refresh look like a replay and revoke the
      // whole session chain.
      expect(cookieValue(res, REFRESH_COOKIE_NAME)).not.toBe(first);
    });

    it('ACCEPTS a cookie refresh with NO CSRF header when the origin is allowed', async () => {
      const loginRes = await login('+989125000007');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      // This is the cold-start case a double-submit-only design cannot serve.
      // The CSRF cookie belongs to the API's origin, so a web app on a
      // different origin can never read it back after a reload and has no
      // token to echo. Origin validation is what keeps the request safe
      // without one -- see `csrf.ts`.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .send({})
        .expect(200);
    });

    it('REJECTS a cookie refresh from a FOREIGN origin', async () => {
      const loginRes = await login('+989125000031');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      // The actual CSRF attack: a page on another site causing the browser to
      // send the cookie. The browser sets `Origin` to the attacker's site and
      // page JavaScript cannot change it -- which is the whole reason this
      // check works.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .send({})
        .expect(403);
    });

    it('REJECTS a cookie refresh carrying NEITHER an origin NOR a token', async () => {
      const loginRes = await login('+989125000032');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);

      // Nothing to verify against, so the request is refused rather than
      // given the benefit of the doubt.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`])
        .send({})
        .expect(403);
    });

    it('REJECTS a cookie refresh whose CSRF header does not match the cookie', async () => {
      const loginRes = await login('+989125000008');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      // A cross-origin attacker can cause the cookie to be SENT but cannot
      // READ it to populate the header.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', 'forged-value')
        .send({})
        .expect(403);
    });

    it('accepts a BODY refresh with no CSRF header, for non-browser clients', async () => {
      const loginRes = await login('+989125000009');
      const bodyToken = loginRes.body.data.refreshToken;

      // A cross-site attacker cannot read the token to put it in a body in
      // the first place, so this path needs no CSRF check. It is what a native
      // app, which has no cookie jar, uses.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: bodyToken })
        .expect(200);
    });

    it('PREFERS the cookie when both are present', async () => {
      const loginRes = await login('+989125000010');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      // Honouring the body here would let a page with XSS downgrade itself out
      // of CSRF protection by supplying a token it stole. With a foreign
      // origin the request is REFUSED rather than quietly falling back to the
      // body -- the presence of a cookie decides which path applies, and that
      // path is then held to its own rules.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .send({ refreshToken: loginRes.body.data.refreshToken })
        .expect(403);
    });

    it('rejects a refresh with neither a cookie nor a body token', async () => {
      await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({}).expect(401);
    });
  });

  describe('concurrent refresh (the benign race)', () => {
    it('does NOT destroy the session when the same cookie is refreshed twice at once', async () => {
      const loginRes = await login('+989125000040');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      const fire = () =>
        request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
          .send({});

      // Two tabs, or two API calls that 401 at the same instant. Exactly one
      // may win; the loser must be denied WITHOUT taking the session with it.
      const [a, b] = await Promise.all([fire(), fire()]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);

      const winner = a.status === 200 ? a : b;
      const newCookie = cookieValue(winner, REFRESH_COOKIE_NAME);
      const newCsrf = winner.body.data.csrfToken;

      // The session is intact: the winner's token still works.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${newCookie}`, `${CSRF_COOKIE_NAME}=${newCsrf}`])
        .set('X-CSRF-Token', newCsrf)
        .send({})
        .expect(200);

      const live = await dataSource.query(
        `SELECT count(*)::int AS n FROM identity.refresh_tokens WHERE revoked_at IS NULL`,
      );
      expect(live[0].n).toBeGreaterThan(0);
    });
  });

  describe('replay detection survives the cookie path', () => {
    it('revokes the WHOLE session chain when a rotated token is presented again', async () => {
      const loginRes = await login('+989125000011');
      const first = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      const refreshed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${first}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', csrf)
        .send({})
        .expect(200);
      const second = cookieValue(refreshed, REFRESH_COOKIE_NAME);
      const csrf2 = refreshed.body.data.csrfToken;

      // Age the rotation past the grace window, so this is unambiguously a
      // replay rather than a concurrent client. Without this the test would
      // be asserting the grace path and silently stop covering the security
      // property it exists for.
      await dataSource.query(
        `UPDATE identity.refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL`,
      );

      // Replaying the ALREADY-ROTATED first token.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${first}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', csrf)
        .send({})
        .expect(401);

      // The whole chain is revoked, not merely that one request denied: a
      // replayed refresh token means someone else has a copy.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${second}`, `${CSRF_COOKIE_NAME}=${csrf2}`])
        .set('X-CSRF-Token', csrf2)
        .send({})
        .expect(401);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM identity.refresh_tokens WHERE revoked_at IS NULL`,
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('logout', () => {
    it('CLEARS both cookies with the same path they were set with', async () => {
      const loginRes = await login('+989125000012');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${loginRes.body.data.accessToken}`)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`])
        .send({})
        .expect(200);

      // A clear with mismatched attributes silently does nothing, leaving a
      // logged-out user holding a live refresh cookie.
      const cleared = cookieHeader(res, REFRESH_COOKIE_NAME);
      expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    });

    it('revokes the token so the cookie cannot be reused after logout', async () => {
      const loginRes = await login('+989125000013');
      const refreshCookie = cookieValue(loginRes, REFRESH_COOKIE_NAME);
      const csrf = loginRes.body.data.csrfToken;

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${loginRes.body.data.accessToken}`)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`])
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshCookie}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set('X-CSRF-Token', csrf)
        .send({})
        .expect(401);
    });

    it('clears the cookies even when no token was presented', async () => {
      const loginRes = await login('+989125000014');
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${loginRes.body.data.accessToken}`)
        .send({})
        .expect(200);

      // A logout that leaves a live cookie because the body happened to be
      // empty is the worst possible outcome of this route.
      expect(cookieHeader(res, REFRESH_COOKIE_NAME)).toBeDefined();
    });
  });

  describe('CSRF comparison', () => {
    it('matches an identical pair and rejects everything else', () => {
      expect(csrfTokenMatches('abc123', 'abc123')).toBe(true);
      expect(csrfTokenMatches('abc123', 'abc124')).toBe(false);
      expect(csrfTokenMatches(null, 'abc123')).toBe(false);
      expect(csrfTokenMatches('abc123', undefined)).toBe(false);
      expect(csrfTokenMatches('', '')).toBe(false);
    });

    it('does not throw on tokens of different LENGTH', () => {
      // `timingSafeEqual` throws on mismatched buffer lengths; hashing both
      // sides to a fixed width keeps the comparison constant-time AND safe
      // for any input.
      expect(csrfTokenMatches('short', 'a-much-longer-token-value')).toBe(false);
    });
  });

  describe('the token is never in a body-readable store', () => {
    it('never returns the refresh token on a route other than login/refresh', async () => {
      const user = await seedUser(app, dataSource, '+989125000015');
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // The session list shows devices, never credentials.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('tokenHash');
      expect(body).not.toContain('refreshToken');
    });
  });
});
