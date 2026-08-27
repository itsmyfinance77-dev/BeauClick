import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, CapturingOtpObserver } from './test-app.factory';

const PHONE = '09121234567';

describe('Authentication flow (e2e)', () => {
  let app: INestApplication;
  let otpObserver: CapturingOtpObserver;
  let dataSource: DataSource;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    otpObserver = testApp.otpObserver;
    dataSource = testApp.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  it('completes the full request-otp -> verify-otp -> refresh -> logout lifecycle', async () => {
    const requestRes = await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone: PHONE, purpose: 'login' });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.data).toEqual({ requested: true });
    expect(requestRes.body.error).toBeNull();

    const code = otpObserver.lastCodeFor('+98' + PHONE.slice(1));

    const verifyRes = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone: PHONE, code, purpose: 'login' });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.accessToken).toBeDefined();
    expect(verifyRes.body.data.refreshToken).toBeDefined();
    expect(verifyRes.body.data.user.phone).toBe('+98' + PHONE.slice(1));

    const { accessToken, refreshToken } = verifyRes.body.data;

    const meRes = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.phone).toBe('+98' + PHONE.slice(1));

    const refreshRes = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).toBeDefined();
    expect(refreshRes.body.data.refreshToken).not.toBe(refreshToken); // rotated

    const logoutRes = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshRes.body.data.accessToken}`)
      .send({ refreshToken: refreshRes.body.data.refreshToken });
    expect(logoutRes.status).toBe(200);
  });

  it('never reveals whether a phone already has an account (anti-enumeration)', async () => {
    const knownPhone = '09121111111';
    const unknownPhone = '09122222222';

    await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone: knownPhone, purpose: 'login' });
    const knownCode = otpObserver.lastCodeFor('+98' + knownPhone.slice(1));
    await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone: knownPhone, code: knownCode, purpose: 'login' });

    const resKnown = await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone: knownPhone, purpose: 'login' });
    const resUnknown = await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone: unknownPhone, purpose: 'login' });

    expect(resKnown.status).toBe(resUnknown.status);
    expect(resKnown.body).toEqual(resUnknown.body);
  });

  describe('invalid OTP', () => {
    it('rejects a wrong code with a generic, non-leaking error', async () => {
      const phone = '09123334444';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });

      const res = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code: '000000', purpose: 'login' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('expired OTP', () => {
    it('rejects a code after its expiry window, with the SAME error shape as a wrong code', async () => {
      const phone = '09125556666';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
      const code = otpObserver.lastCodeFor('+98' + phone.slice(1));

      // Test config sets OTP_EXPIRY_SECONDS=2 specifically so this test doesn't need a long sleep.
      await new Promise((resolve) => setTimeout(resolve, 2100));

      const res = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('کد وارد شده نامعتبر یا منقضی شده است.');
    });
  });

  describe('reused OTP (replay)', () => {
    it('a correct code can only ever be consumed once', async () => {
      const phone = '09127778888';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
      const code = otpObserver.lastCodeFor('+98' + phone.slice(1));

      const first = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
      expect(first.status).toBe(200);

      const second = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('attempt lockout', () => {
    it('kills the code after OTP_MAX_ATTEMPTS (test config: 3) wrong guesses, even before expiry', async () => {
      const phone = '09129990000';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
      const realCode = otpObserver.lastCodeFor('+98' + phone.slice(1));
      const wrongCode = realCode === '111111' ? '222222' : '111111';

      for (let i = 0; i < 3; i += 1) {
        await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code: wrongCode, purpose: 'login' });
      }

      // The REAL code, presented after 3 failed attempts, must now also
      // fail -- the code is dead, not just "3 guesses used up." This is a
      // distinct, more specific failure (429 RATE_LIMITED: "request a new
      // code") than a plain wrong/expired code (400 VALIDATION_ERROR) --
      // OtpService's own OtpVerifyResult already distinguishes
      // 'too_many_attempts' from 'invalid_or_expired', and AuthService maps
      // each to its own exception; V3_SECURITY_MODEL.md §2's anti-
      // enumeration requirement only mandates identical errors for
      // "expired" vs. "never requested", not for this case.
      const res = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code: realCode, purpose: 'login' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('rate limiting', () => {
    it('rejects requesting more than OTP_MAX_PER_PHONE_PER_HOUR (test config: 5) codes for the same phone within the window', async () => {
      const phone = '09121230000';
      let lastStatus = 0;
      for (let i = 0; i < 6; i += 1) {
        const res = await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe('token revocation', () => {
    it('a revoked refresh token can never be used to obtain a new access token again', async () => {
      const phone = '09124440000';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
      const code = otpObserver.lastCodeFor('+98' + phone.slice(1));
      const verify = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
      const { accessToken, refreshToken } = verify.body.data;

      const logout = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(logout.status).toBe(200);

      const refreshAfterLogout = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(refreshAfterLogout.status).toBe(401);
    });

    it('replaying an already-rotated refresh token revokes the entire session chain', async () => {
      const phone = '09124450000';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
      const code = otpObserver.lastCodeFor('+98' + phone.slice(1));
      const verify = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
      const originalRefreshToken = verify.body.data.refreshToken;

      const firstRotation = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: originalRefreshToken });
      expect(firstRotation.status).toBe(200);
      const rotatedRefreshToken = firstRotation.body.data.refreshToken;

      // Age the rotation past the replay GRACE WINDOW.
      //
      // Without this the replay lands inside the window that exists to absorb
      // a benign concurrent refresh (two tabs, or two API calls that 401 at
      // once), and the chain is deliberately left intact -- so the test would
      // silently stop covering the security property it exists for. See
      // TokenService.REPLAY_GRACE_MS.
      await dataSource.query(
        `UPDATE identity.refresh_tokens SET revoked_at = revoked_at - interval '1 hour' WHERE revoked_at IS NOT NULL`,
      );

      // Replay the ALREADY-ROTATED (stale) token -- a real security event.
      const replay = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: originalRefreshToken });
      expect(replay.status).toBe(401);

      // The legitimate, freshly-rotated token must ALSO be dead now -- the
      // whole chain was revoked as a precaution, not just the replayed one.
      const afterReplay = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: rotatedRefreshToken });
      expect(afterReplay.status).toBe(401);
    });
  });

  /**
   * DEVELOPMENT-ONLY QA login (`V3.1_DEV_QA_AUTH.md`). The route reads its
   * policy from `process.env` on every request, so these cases drive the env
   * around each call. The production case is the load-bearing one and is
   * restored in a `finally` so a failure cannot leave the process marked
   * production for the rest of the suite.
   */
  describe('dev-login (development-only QA auth)', () => {
    const QA_PHONE = '09121110009';
    const QA_CANONICAL = '+98' + QA_PHONE.slice(1);

    afterEach(() => {
      delete process.env.DEV_QA_LOGIN;
      delete process.env.DEV_QA_LOGIN_PHONES;
      delete process.env.NODE_ENV;
    });

    it('is UNAVAILABLE in production even with the flag AND the phone allow-listed (the mandatory guard)', async () => {
      const prior = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        process.env.DEV_QA_LOGIN = '1';
        process.env.DEV_QA_LOGIN_PHONES = QA_CANONICAL;

        const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ phone: QA_PHONE });
        expect(res.status).toBe(404);
        expect(res.body?.data?.accessToken).toBeUndefined();
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });

    it('is UNAVAILABLE when the flag is unset, even in development', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_QA_LOGIN_PHONES = QA_CANONICAL;
      const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ phone: QA_PHONE });
      expect(res.status).toBe(404);
    });

    it('REJECTS a phone that is not on the allow-list, even when enabled', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_QA_LOGIN = '1';
      process.env.DEV_QA_LOGIN_PHONES = '+989120000000';
      const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ phone: QA_PHONE });
      expect(res.status).toBe(404);
    });

    it('issues a NORMAL session for an allow-listed phone in development, usable against a protected route', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_QA_LOGIN = '1';
      process.env.DEV_QA_LOGIN_PHONES = QA_CANONICAL;

      const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ phone: QA_PHONE });
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.csrfToken).toBeDefined();
      expect(res.body.data.user.phone).toBe(QA_CANONICAL);
      // Roles/capabilities come from `resolveAccess`, identical to the real
      // login. Their concrete values are asserted against a REAL database in
      // operability-foundation.pg-spec (the in-memory DataSource here does not
      // round-trip the default-role grant); what this e2e proves is the session
      // itself, below.

      // The produced session is a NORMAL one: it authenticates a protected
      // route with no special handling, proving the token is issued through the
      // same path as a real login.
      const me = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.phone).toBe(QA_CANONICAL);
    });
  });
});
