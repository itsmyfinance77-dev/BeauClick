import { REDACTED, redact, redactText } from './redact';

/**
 * Redaction (V3.1 Phase F).
 *
 * The property under test is not "the deny-list is correct" -- a list is
 * self-evident. It is that the shapes this platform ACTUALLY emits into an
 * error message cannot reach a log aggregator, because that is a second copy
 * of whatever reaches it, retained for months, readable by more people than
 * can read the database.
 *
 * Every fixture below is a real shape from this codebase: a `QueryFailedError`
 * quoting its connection string, an access token, an OTP record, an Iranian
 * phone number, a gateway response.
 */
describe('redact', () => {
  describe('by value shape — the half that reaches error messages', () => {
    it('removes a connection string with credentials', () => {
      // Every pg connection error and several TypeORM errors quote one.
      const message = 'connect ECONNREFUSED postgres://beauclick_app:dev_app@db.internal:5432/beauclick_v3';
      const out = redactText(message);
      expect(out).not.toContain('dev_app');
      expect(out).not.toContain('beauclick_app:');
      expect(out).toContain(REDACTED);
    });

    it('removes an access token', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMWEwNGE2MiIsInNpZCI6ImFiYyJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(redactText(`Unauthorized for token ${jwt}`)).not.toContain('eyJhbGciOi');
    });

    it('removes an Authorization header quoted back by an HTTP client', () => {
      expect(redactText('request failed: headers={authorization: Bearer sk_live_9Kd2mQx7vRt4wZp1}')).not.toContain(
        'sk_live_9Kd2mQx7vRt4wZp1',
      );
    });

    it('removes an Iranian phone number in every shape this platform handles', () => {
      for (const phone of ['+989123456789', '00989123456789', '989123456789', '09123456789']) {
        const out = redactText(`no user for ${phone}`);
        expect(out).not.toContain('9123456789');
        expect(out).toContain(REDACTED);
      }
    });

    it('removes a long opaque credential', () => {
      const hex = 'a3f5c9d2b7e14608a3f5c9d2b7e14608a3f5c9d2';
      expect(redactText(`hmac mismatch: ${hex}`)).not.toContain(hex);
    });

    it('leaves a UUID alone, because ids are what make a log useful', () => {
      // 36 characters WITH hyphens. Redacting these would remove the order id,
      // the correlation id, and the user id from every line -- which is most
      // of why anyone reads the log.
      const id = '01a04a62-7578-7a6f-ad3e-41398619a2f6';
      expect(redactText(`order ${id} not payable`)).toContain(id);
    });

    it('leaves ordinary Persian and English text alone', () => {
      const message = 'این مورد یافت نشد. order not payable: already_paid';
      expect(redactText(message)).toBe(message);
    });

    it('is not stateful across calls', () => {
      // The patterns are module-level /g regexes. A stateful `lastIndex`
      // carried between calls makes redaction INTERMITTENT, which is worse
      // than absent because it passes a spot check.
      const phone = '+989123456789';
      for (let i = 0; i < 5; i += 1) {
        expect(redactText(`user ${phone}`)).not.toContain('9123456789');
      }
    });
  });

  describe('by key — the half that catches structured records', () => {
    it('replaces a forbidden field whatever it holds', () => {
      const out = redact({
        userId: 'u1',
        password: 'anything',
        jwtAccessSecret: 'anything',
        OTP_HMAC_SECRET: 'anything',
        phone: '+989123456789',
        authorization: 'anything',
      }) as Record<string, unknown>;

      expect(out.userId).toBe('u1');
      for (const key of ['password', 'jwtAccessSecret', 'OTP_HMAC_SECRET', 'phone', 'authorization']) {
        expect({ key, value: out[key] }).toEqual({ key, value: REDACTED });
      }
    });

    it('recurses into nested records', () => {
      const out = redact({ request: { headers: { authorization: 'Bearer x' }, body: { code: '123456' } } }) as {
        request: { headers: Record<string, unknown>; body: Record<string, unknown> };
      };
      expect(out.request.headers.authorization).toBe(REDACTED);
      expect(out.request.body.code).toBe(REDACTED);
    });
  });

  describe('structural safety', () => {
    it('keeps an Error usable while redacting its message and stack', () => {
      const error = new Error('connect failed postgres://app:hunter2@db/x');
      const out = redact(error) as { name: string; message: string; stack?: string };
      expect(out.name).toBe('Error');
      expect(out.message).not.toContain('hunter2');
      // The stack is the single most useful field in an error log, so it is
      // kept -- redacted, because a frame's arguments and a nested `caused by`
      // routinely carry the value that caused the failure.
      expect(out.stack).toBeDefined();
    });

    it('bounds depth rather than following a circular object graph forever', () => {
      // A TypeORM entity carries parent/child relations. An unbounded walk
      // either never terminates or serialises the whole graph into one line.
      const circular: Record<string, unknown> = { name: 'root' };
      circular.self = circular;
      const out = JSON.stringify(redact(circular));
      expect(out).toContain('too deep');
    });

    it('bounds array length rather than logging a whole result set', () => {
      const out = redact(Array.from({ length: 120 }, (_, i) => i)) as unknown[];
      expect(out).toHaveLength(51);
      expect(out[50]).toBe('[70 more]');
    });

    it('never throws on the odd shapes a real error carries', () => {
      for (const value of [undefined, null, NaN, Infinity, Symbol('x'), () => undefined, new Date(0), 10n]) {
        expect(() => redact(value)).not.toThrow();
      }
    });

    it('renders a Date as an ISO string rather than an empty object', () => {
      expect(redact(new Date('2026-08-29T00:00:00.000Z'))).toBe('2026-08-29T00:00:00.000Z');
    });
  });
});
