import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';
import { ALL_EVENT_CONTRACTS } from '@beauclick/event-contracts';
import {
  REFERRAL_CLAIM_ATTEMPTS_PER_HOUR,
  REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS,
  REFERRAL_CLAIM_REFUSED_CODE,
  REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS,
} from '@beauclick/referral-contract';
import { ReferralService } from '@beauclick/referral';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

const DAY_MS = 86_400_000;

/**
 * Referral attribution — the claim lifecycle, proved against real PostgreSQL
 * (V3.2-C Story #27, ADR-036).
 *
 * ## Why essentially all of this lives here rather than in the fast suite
 *
 * Every guarantee Story #27 makes is a **database** guarantee or a
 * **concurrency** guarantee, and pg-mem honours neither: it does not enforce
 * the unique index the way a real one does under concurrent transactions, it
 * has no triggers, and it does not even honour `ROLLBACK`. Proving "attributed
 * once, ever" against a fake would prove that the fake agrees with itself.
 *
 * So: two simultaneous claims, a raw `INSERT` that bypasses the service, a
 * trigger that refuses an `UPDATE`, and a throttle whose whole point is that
 * ten concurrent requests cannot become eleven. Here or nowhere.
 *
 * ## The non-vacuity discipline this file follows
 *
 * Several cases below assert an **absence** — no code in the logs, no
 * attribution event, no eligibility reason in an export. An absence assertion
 * that passes because the detector was pointed at nothing is worse than no
 * assertion, and this suite has been bitten once already: `referral.pg-spec`'s
 * `recordLogging` docblock records a version that captured only the process
 * streams and passed while capturing **nothing**.
 *
 * So every absence check here is paired with a **planted positive**: the same
 * detector, the same path, a value that must be found. If the plant is not
 * found, the detector is broken and the test fails — before the real assertion
 * is trusted.
 */
describePg('referral attribution — claim lifecycle, concurrency, privacy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let referral: ReferralService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    referral = app.get(ReferralService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    ctx.referralClock.release();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const http = () => request(app.getHttpServer());

  let seq = 0;
  async function customer(): Promise<SeededUser> {
    seq += 1;
    return seedUser(app, dataSource, `+9891390${String(seq).padStart(5, '0')}`);
  }

  /** The caller's own code, through the real Story #11 route. */
  async function codeOf(user: SeededUser): Promise<string> {
    const response = await http()
      .get('/api/v1/me/referral/code')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    return response.body.data.code as string;
  }

  const claim = (user: SeededUser, code: unknown, body: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/me/referral/claim')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ code, ...body });

  /**
   * Moves an account's `created_at` back by `days`, to the millisecond.
   *
   * Ageing the ROW rather than moving the clock, because the two are not
   * interchangeable here: the claim window compares `users.created_at` against
   * `clock.now() - 30 days`, and only one of those two is the thing under test
   * in any given case. Where the boundary itself is the subject, the clock is
   * ALSO frozen so the comparison has no moving part at all.
   */
  async function ageAccount(user: SeededUser, ms: number): Promise<void> {
    await dataSource.query('UPDATE identity.users SET created_at = created_at - $2::interval WHERE id = $1', [
      user.id,
      `${ms} milliseconds`,
    ]);
  }

  async function storedAttributions(): Promise<
    Array<{
      referrer_user_id: string;
      referee_user_id: string;
      referral_code_id: string;
      attributed_at: Date;
      expires_at: Date;
      referrer_erased_at: Date | null;
      referee_erased_at: Date | null;
    }>
  > {
    return dataSource.query('SELECT * FROM referral.referrals ORDER BY attributed_at, id');
  }

  /** A professional to hang bookings on. Its owner is a separate seeded user. */
  async function someProfessional(): Promise<string> {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+9891490${String(seq).padStart(5, '0')}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, `متخصص ${seq}`);
    return professional.id;
  }

  /**
   * Gives `user` a booking in `status`, through the real booking tables.
   *
   * `booking.bookings.slot_id` carries a real foreign key to
   * `booking.availability_slots`, so the slot is seeded rather than invented --
   * which is the point of going through the real tables at all. A test that
   * fabricated a booking row would prove the port reads a shape this platform
   * does not actually store.
   */
  async function seedBooking(user: SeededUser, status: string): Promise<void> {
    const professionalId = await someProfessional();
    const startAt = new Date(Date.now() - 2 * DAY_MS);
    const slotId = await seedSlot(dataSource, professionalId, null, startAt);

    await dataSource.query(
      `INSERT INTO booking.bookings
         (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status, completed_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8)`,
      [
        uuidv7(),
        user.id,
        professionalId,
        slotId,
        startAt,
        new Date(startAt.getTime() + 3_600_000),
        status,
        status === 'completed' ? startAt : null,
      ],
    );
  }

  const completeABooking = (user: SeededUser) => seedBooking(user, 'completed');

  /**
   * Everything logged while `run` executed, captured two ways.
   *
   * Lifted deliberately from `referral.pg-spec.ts`, whose docblock records why
   * BOTH halves are needed: `args` is the exact material a log line is built
   * from, so a value that never appears there cannot appear in a line however
   * the sink is configured, and `output` covers anything logging outside Nest's
   * `Logger`. An earlier version captured only the streams and passed while
   * capturing nothing.
   */
  async function recordLogging<T>(run: () => Promise<T>): Promise<{ result: T; args: string; output: string }> {
    const args: unknown[] = [];
    let output = '';

    const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
    const loggerSpies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(((...called: unknown[]) => {
        args.push(...called);
      }) as never),
    );

    const capture = (chunk: unknown): boolean => {
      output += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);

    try {
      const result = await run();
      return { result, args: JSON.stringify(args), output };
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const spy of loggerSpies) spy.mockRestore();
    }
  }

  // ==========================================================================
  // 1. The happy path, and what the row actually contains
  // ==========================================================================

  describe('a valid claim', () => {
    it('attributes the caller to the code owner, once', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const response = await claim(referee, code).expect(200);

      expect(response.body.data).toEqual({
        attributedAt: expect.any(String),
        expiresAt: expect.any(String),
      });

      const rows = await storedAttributions();
      expect(rows).toHaveLength(1);
      expect(rows[0].referrer_user_id).toBe(referrer.id);
      expect(rows[0].referee_user_id).toBe(referee.id);
    });

    it('stores the code ID and NEVER the code string', async () => {
      // ADR-036 §2. The strongest form of this is structural: the column holds
      // a UUID, so a ten-character bearer credential cannot fit in it even if
      // somebody tried.
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      await claim(referee, code).expect(200);

      const [row] = await storedAttributions();
      const [codeRow] = await dataSource.query('SELECT id FROM referral.referral_codes WHERE code = $1', [code]);
      expect(row.referral_code_id).toBe(codeRow.id);

      // And the string appears nowhere in the table, under any column.
      const dump = JSON.stringify(await storedAttributions());
      expect(dump).not.toContain(code);
    });

    it('computes expires_at as EXACTLY 90 days after attributed_at, from one clock reading', async () => {
      // `V32-DEC-017`, ADR-036 §5. Asserted to the MILLISECOND rather than
      // "about 90 days", because the failure this catches is a second reading
      // of the clock -- which would make the gap 90 days plus however long the
      // transaction took, and would pass any tolerance-based check.
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const frozen = new Date('2026-06-15T11:22:33.456Z');
      ctx.referralClock.freeze(frozen);

      const response = await claim(referee, code).expect(200);

      expect(response.body.data.attributedAt).toBe(frozen.toISOString());
      expect(response.body.data.expiresAt).toBe(
        new Date(frozen.getTime() + REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS * DAY_MS).toISOString(),
      );

      const [row] = await storedAttributions();
      expect(row.expires_at.getTime() - row.attributed_at.getTime()).toBe(
        REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS * DAY_MS,
      );
    });

    it('is an absolute duration, not a calendar boundary — proved across a leap February', async () => {
      // The distinction ADR-036 §5 draws. Three CALENDAR months from 1 December
      // is 1 March. Ninety DAYS from 2027-12-01 is 2028-02-29, because 2028 is a
      // leap year -- so a `setUTCMonth(+3)` implementation returns 2028-03-01
      // here and passes every same-length-month test.
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const frozen = new Date('2027-12-01T00:00:00.000Z');
      ctx.referralClock.freeze(frozen);
      // The referee's account must be young RELATIVE TO the frozen instant.
      // Without this the claim is refused for being ~15 months old, and the test
      // fails for a reason that has nothing to do with the arithmetic it exists
      // to check -- which is how it first failed.
      await dataSource.query('UPDATE identity.users SET created_at = $2 WHERE id = $1', [
        referee.id,
        new Date(frozen.getTime() - DAY_MS),
      ]);

      const response = await claim(referee, code).expect(200);

      expect(response.body.data.expiresAt).toBe('2028-02-29T00:00:00.000Z');
    });

    it('leaves both tombstone markers null', async () => {
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      const [row] = await storedAttributions();
      expect(row.referrer_erased_at).toBeNull();
      expect(row.referee_erased_at).toBeNull();
    });

    it('lets ONE referrer invite many people', async () => {
      // Only the referee is capped, and at one. A unique index on the referrer
      // would break the entire product, so it is asserted rather than assumed.
      const referrer = await customer();
      const code = await codeOf(referrer);

      for (let i = 0; i < 3; i += 1) {
        await claim(await customer(), code).expect(200);
      }

      expect(await storedAttributions()).toHaveLength(3);
    });
  });

  // ==========================================================================
  // 2. The account-age boundary — inclusive at exactly 30 days
  // ==========================================================================

  describe('the 30-day claim window', () => {
    /** Ages the referee to exactly `offsetMs` beyond 30 days and claims. */
    async function claimAtAge(offsetMs: number) {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      // Freeze FIRST, then age the row against that same instant, so the
      // comparison has no moving part. Without the freeze, the milliseconds
      // between the UPDATE and the request decide the outcome -- which is
      // exactly how a boundary test becomes a coin flip.
      const frozen = ctx.referralClock.freeze();
      await dataSource.query('UPDATE identity.users SET created_at = $2 WHERE id = $1', [
        referee.id,
        new Date(frozen.getTime() - REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS * DAY_MS - offsetMs),
      ]);

      return claim(referee, code);
    }

    it('ACCEPTS an account exactly 30 days old, to the millisecond', async () => {
      // Issue #27 says "<= 30 days", so the boundary is INCLUSIVE. Implemented
      // as `<` this refuses exactly one customer per boundary, invisibly.
      expect((await claimAtAge(0)).status).toBe(200);
      expect(await storedAttributions()).toHaveLength(1);
    });

    it('REFUSES an account one millisecond older', async () => {
      expect((await claimAtAge(1)).status).toBe(409);
      expect(await storedAttributions()).toHaveLength(0);
    });

    it('accepts an account one millisecond younger than the boundary', async () => {
      expect((await claimAtAge(-1)).status).toBe(200);
    });

    it('refuses an account far outside the window', async () => {
      expect((await claimAtAge(400 * DAY_MS)).status).toBe(409);
    });
  });

  // ==========================================================================
  // 3. The completed-booking exclusion
  // ==========================================================================

  describe('the completed-booking exclusion', () => {
    it('refuses a claimant who has completed a booking', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      await completeABooking(referee);

      await claim(referee, code).expect(409);
      expect(await storedAttributions()).toHaveLength(0);
    });

    it('ACCEPTS a claimant whose only bookings are not completed', async () => {
      // The other half, and the one that catches an implementation that checked
      // "has any booking" instead of "has a COMPLETED booking". `V32-DEC-018`
      // draws the same line from the other direction: `BookingConfirmed` never
      // qualifies.
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      for (const status of ['pending', 'confirmed', 'cancelled', 'expired', 'no_show']) {
        await seedBooking(referee, status);
      }

      await claim(referee, code).expect(200);
      expect(await storedAttributions()).toHaveLength(1);
    });

    it('is not confused by SOMEBODY ELSE completing a booking', async () => {
      // Catches a port whose predicate lost its `customer_id` scoping -- which
      // would refuse every claim on the platform the moment any customer
      // completed anything, and would look like a product rule working.
      const referrer = await customer();
      const referee = await customer();
      const stranger = await customer();
      const code = await codeOf(referrer);

      await completeABooking(stranger);

      await claim(referee, code).expect(200);
    });
  });

  // ==========================================================================
  // 4. Indistinguishable refusals — COMPLETE bodies, not status codes
  // ==========================================================================

  describe('the indistinguishable refusal', () => {
    it('returns a byte-identical body for every eligibility failure', async () => {
      // `V32-DEC-019`, ADR-036 §8. The assertion is on the COMPLETE response
      // body plus the status, because a status-only check passes while a
      // `details.reason` leaks the branch -- which is the failure this exists to
      // catch.
      const bodies: Array<{ label: string; status: number; body: unknown }> = [];

      // (a) A well-formed code that was never issued.
      {
        const referee = await customer();
        const response = await claim(referee, 'ZZZZZZZZZZ');
        bodies.push({ label: 'unknown code', status: response.status, body: response.body });
      }

      // (b) A code whose owner has been erased -- the "revoked" case, which is
      // an ABSENT row because erasure hard-deletes (ADR-035 §2, ADR-036 §4).
      {
        const owner = await customer();
        const code = await codeOf(owner);
        await dataSource.query('DELETE FROM referral.referral_codes WHERE owner_user_id = $1', [owner.id]);
        const referee = await customer();
        const response = await claim(referee, code);
        bodies.push({ label: 'revoked/deleted code', status: response.status, body: response.body });
      }

      // (c) The caller's own code.
      {
        const user = await customer();
        const response = await claim(user, await codeOf(user));
        bodies.push({ label: 'own code', status: response.status, body: response.body });
      }

      // (d) A caller who has already been attributed.
      {
        const referrer = await customer();
        const referee = await customer();
        await claim(referee, await codeOf(referrer)).expect(200);
        const second = await customer();
        const response = await claim(referee, await codeOf(second));
        bodies.push({ label: 'already attributed', status: response.status, body: response.body });
      }

      // (e) An account older than the window.
      {
        const referrer = await customer();
        const referee = await customer();
        const code = await codeOf(referrer);
        await ageAccount(referee, 400 * DAY_MS);
        const response = await claim(referee, code);
        bodies.push({ label: 'account too old', status: response.status, body: response.body });
      }

      // (f) A caller with a completed booking.
      {
        const referrer = await customer();
        const referee = await customer();
        const code = await codeOf(referrer);
        await completeABooking(referee);
        const response = await claim(referee, code);
        bodies.push({ label: 'already booked', status: response.status, body: response.body });
      }

      expect(bodies).toHaveLength(6);

      // Every one is 409 with the SAME complete body.
      const [first, ...rest] = bodies;
      expect(first.status).toBe(409);
      for (const other of rest) {
        expect({ status: other.status, body: other.body }).toEqual({ status: first.status, body: first.body });
      }

      // And the shared body carries nothing that could name a cause.
      const serialised = JSON.stringify(first.body);
      expect(serialised).toContain(REFERRAL_CLAIM_REFUSED_CODE);
      for (const leak of [
        'reason',
        'details',
        'unknown',
        'revoked',
        'own',
        'attributed',
        'too_old',
        'booked',
        'exists',
        'owner',
      ]) {
        expect(serialised.toLowerCase()).not.toContain(leak);
      }
    });

    it('is non-vacuous: the comparison DOES detect a difference', async () => {
      // The guard for the case above. If `toEqual` over these objects could not
      // see a changed `details` payload, the six-way comparison would pass no
      // matter what the route returned.
      const referee = await customer();
      const real = await claim(referee, 'ZZZZZZZZZZ');
      const tampered = { status: real.status, body: { ...real.body, data: { reason: 'unknown_code' } } };

      expect(() => expect(tampered).toEqual({ status: real.status, body: real.body })).toThrow();
    });

    it('reveals no referrer identity in a refusal or a success', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const success = await claim(referee, code).expect(200);
      const refusal = await claim(referee, code).expect(409);

      for (const response of [success, refusal]) {
        const serialised = JSON.stringify(response.body);
        expect(serialised).not.toContain(referrer.id);
        expect(serialised).not.toContain(referrer.phone);
        expect(serialised).not.toContain(code);
      }
    });

    it('does not distinguish an existing code from a non-existent one by timing class', async () => {
      // Not a timing-attack assertion -- those are unreliable in CI and this is
      // not claiming constant time. It asserts the weaker, meaningful property:
      // both paths perform the SAME KIND of work, so neither short-circuits
      // before the database in a way an attacker could measure trivially.
      //
      // Both refusals run the full pipeline: throttle charge, then a lookup.
      const owner = await customer();
      const realCode = await codeOf(owner);
      const referee = await customer();
      await ageAccount(referee, 400 * DAY_MS);

      const known = await claim(referee, realCode).expect(409);
      const unknown = await claim(referee, 'ZZZZZZZZZZ').expect(409);
      expect(known.body).toEqual(unknown.body);

      // Both consumed an attempt, which is the observable proof that neither
      // returned before reaching the throttle.
      const [counter] = await dataSource.query(
        'SELECT attempt_count FROM referral.claim_attempts WHERE claimant_user_id = $1',
        [referee.id],
      );
      expect(counter.attempt_count).toBe(2);
    });
  });

  // ==========================================================================
  // 5. Forged identity fields, and the shape gate
  // ==========================================================================

  describe('forged input', () => {
    it('REFUSES every forged identity field with 400 rather than ignoring it', async () => {
      const referrer = await customer();
      const referee = await customer();
      const victim = await customer();
      const code = await codeOf(referrer);

      const forgeries: Array<Record<string, unknown>> = [
        { refereeUserId: victim.id },
        { referrerUserId: victim.id },
        { ownerUserId: victim.id },
        { userId: victim.id },
        { phone: victim.phone },
        { createdAt: new Date(0).toISOString() },
        { accountCreatedAt: new Date(0).toISOString() },
        { hasCompletedBooking: false },
        { rewardAmount: 1000 },
        { expiresAt: new Date(0).toISOString() },
        { attributedAt: new Date(0).toISOString() },
        { status: 'qualified' },
        { attributionStatus: 'qualified' },
      ];

      for (const forgery of forgeries) {
        const response = await claim(referee, code, forgery);
        expect({ forgery, status: response.status }).toEqual({ forgery, status: 400 });
      }

      // Nothing was written by any of them.
      expect(await storedAttributions()).toHaveLength(0);
    });

    it('is non-vacuous: the SAME request without the forged field succeeds', async () => {
      // Without this, every case above would pass if the route were simply
      // broken -- a 400 for everything looks identical to a 400 for forgeries.
      const referrer = await customer();
      const referee = await customer();

      await claim(referee, await codeOf(referrer)).expect(200);
    });

    it('NEVER echoes the submitted code back, malformed or not', async () => {
      // A REGRESSION TEST for a real leak this suite found.
      //
      // The DTO originally carried `@Matches(/^[ALPHABET]{10}$/)`. The platform's
      // `ValidationException` serialises class-validator's `ValidationError`,
      // which carries `target` and `value` -- the submitted payload -- so a
      // malformed code came back as `{"target":{"code":"…"},"value":"…"}`. A
      // custom `message` does not help: the echo is the pipe's, not the
      // constraint's.
      //
      // The realistic trigger is not an attacker. It is a customer typing their
      // inviter's REAL code in lowercase: malformed, because
      // `isReferralCodeShape` is deliberately case-sensitive, and one
      // `toUpperCase()` away from the live credential. `V32-DEC-033` keeps a
      // referral code out of exception messages.
      const referrer = await customer();
      const referee = await customer();
      const realCode = await codeOf(referrer);

      const probes = [
        realCode.toLowerCase(), // the credential, modulo case -- the case that mattered
        realCode.slice(0, 9),
        `${realCode}A`,
        'SHORT',
        'TOOLONGTOOLONG',
        'ABCDEFGHI0',
        'AAAA-AAAAA',
        '',
      ];

      for (const probe of probes) {
        const response = await claim(referee, probe);
        const serialised = JSON.stringify(response.body);
        if (probe.length > 0) {
          expect({ probe, leaked: serialised.includes(probe) }).toEqual({ probe, leaked: false });
        }
        // And nothing reveals the real code either, by any casing.
        expect(serialised.toUpperCase()).not.toContain(realCode);
      }
    });

    it('folds a malformed code into the SAME collapsed refusal as an unknown one', async () => {
      // The consequence of moving the shape check out of the DTO: the route now
      // makes one FEWER distinction than it did. A malformed code and a
      // well-formed code that was never issued are byte-identical.
      const referee = await customer();

      const malformed = await claim(referee, 'not-a-code').expect(409);
      const unknown = await claim(referee, 'ZZZZZZZZZZ').expect(409);

      expect(malformed.body).toEqual(unknown.body);
    });

    it('charges a malformed probe a throttle attempt, so probing is not free', async () => {
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:30:00.000Z'));

      await claim(referee, 'garbage').expect(409);
      await claim(referee, '').expect(409);

      const [row] = await dataSource.query(
        'SELECT attempt_count FROM referral.claim_attempts WHERE claimant_user_id = $1',
        [referee.id],
      );
      expect(row.attempt_count).toBe(2);
    });

    it('rejects a non-string code with 400', async () => {
      // `@IsString()` remains on the DTO: a non-string is not a code and cannot
      // leak one, so the pipe's echo is harmless here.
      const referee = await customer();
      for (const wrongType of [null, 42, true, { code: 'x' }, ['ZZZZZZZZZZ']]) {
        await claim(referee, wrongType).expect(400);
      }
    });

    it('rejects an unauthenticated claim with 401, not 404', async () => {
      // The route must exist and be gated by AUTHENTICATION. A 404 would mean
      // the route was never mapped and every other case here was testing
      // nothing.
      await http().post('/api/v1/me/referral/claim').send({ code: 'ZZZZZZZZZZ' }).expect(401);
    });
  });

  // ==========================================================================
  // 6. The throttle
  // ==========================================================================

  describe('the claim throttle', () => {
    it('allows exactly 10 attempts per hour and refuses the 11th with 429', async () => {
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:30:00.000Z'));

      // Ten refusals -- proving a REFUSED attempt consumes a slot, which is the
      // property `V32-DEC-034` prices the code length against (ADR-036 §6a).
      for (let i = 0; i < REFERRAL_CLAIM_ATTEMPTS_PER_HOUR; i += 1) {
        await claim(referee, 'ZZZZZZZZZZ').expect(409);
      }

      const spent = await claim(referee, 'ZZZZZZZZZZ').expect(429);
      // The platform envelope puts a DomainException's payload under `error`.
      expect(spent.body.error.code).toBe('REFERRAL_CLAIM_THROTTLED');
      expect(spent.body.error.details.attemptsPerHour).toBe(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);
      // No retryAfter, and no count of attempts made or remaining -- either
      // would let a caller measure the counter's state (ADR-036 §6c).
      expect(JSON.stringify(spent.body)).not.toMatch(/retryAfter|remaining|attemptCount|windowStart/i);
      // And a spent throttle is NOT the eligibility refusal.
      expect(JSON.stringify(spent.body)).not.toContain(REFERRAL_CLAIM_REFUSED_CODE);
    });

    it('charges a SUCCESSFUL claim an attempt too', async () => {
      // ADR-036 §6b: success consumes one, like every other request. No reset,
      // no refund.
      const referrer = await customer();
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:30:00.000Z'));

      await claim(referee, await codeOf(referrer)).expect(200);

      const [row] = await dataSource.query(
        'SELECT attempt_count FROM referral.claim_attempts WHERE claimant_user_id = $1',
        [referee.id],
      );
      expect(row.attempt_count).toBe(1);
    });

    it('is per caller — one claimant exhausting the limit does not block another', async () => {
      const first = await customer();
      const second = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:30:00.000Z'));

      for (let i = 0; i < REFERRAL_CLAIM_ATTEMPTS_PER_HOUR; i += 1) {
        await claim(first, 'ZZZZZZZZZZ').expect(409);
      }
      await claim(first, 'ZZZZZZZZZZ').expect(429);

      // The other caller is untouched.
      await claim(second, 'ZZZZZZZZZZ').expect(409);
    });

    it('resets in the next hour bucket', async () => {
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:59:00.000Z'));

      for (let i = 0; i < REFERRAL_CLAIM_ATTEMPTS_PER_HOUR; i += 1) {
        await claim(referee, 'ZZZZZZZZZZ').expect(409);
      }
      await claim(referee, 'ZZZZZZZZZZ').expect(429);

      ctx.referralClock.freeze(new Date('2026-06-15T11:00:00.000Z'));
      await claim(referee, 'ZZZZZZZZZZ').expect(409);

      // Two rows, one per bucket -- the bucketing is what keeps concurrent
      // claimants off one hot row (ADR-036 §6).
      const rows = await dataSource.query(
        'SELECT window_start, attempt_count FROM referral.claim_attempts WHERE claimant_user_id = $1 ORDER BY window_start',
        [referee.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].attempt_count).toBe(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);
      expect(rows[1].attempt_count).toBe(1);
    });

    it('CONCURRENT attempts cannot exceed the limit', async () => {
      // The case the in-memory throttler cannot pass and a read-then-write
      // counter cannot pass. Twenty simultaneous requests, one caller: exactly
      // ten must be charged and the counter must land on exactly ten.
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-06-15T10:30:00.000Z'));

      const attempts = 20;
      const responses = await Promise.all(
        Array.from({ length: attempts }, () => claim(referee, 'ZZZZZZZZZZ')),
      );

      const charged = responses.filter((response) => response.status === 409).length;
      const throttled = responses.filter((response) => response.status === 429).length;

      expect(charged).toBe(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);
      expect(throttled).toBe(attempts - REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);

      // The counter itself never exceeded the limit -- the conditional write is
      // what guarantees this, not the response tally.
      const [row] = await dataSource.query(
        'SELECT attempt_count FROM referral.claim_attempts WHERE claimant_user_id = $1',
        [referee.id],
      );
      expect(row.attempt_count).toBe(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);
    });
  });

  // ==========================================================================
  // 7. Concurrency, uniqueness, replay, immutability
  // ==========================================================================

  describe('concurrency and immutability', () => {
    it('two simultaneous claims for one referee create EXACTLY ONE row', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const [a, b] = await Promise.all([claim(referee, code), claim(referee, code)]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(await storedAttributions()).toHaveLength(1);
      // The loser's refusal is the SAME body as every other refusal -- a
      // concurrency loss must not be distinguishable either.
      const loser = a.status === 409 ? a : b;
      const unrelated = await claim(await customer(), 'ZZZZZZZZZZ').expect(409);
      expect(loser.body).toEqual(unrelated.body);
    });

    it('two DIFFERENT valid codes raced by one referee produce one immutable winner', async () => {
      const first = await customer();
      const second = await customer();
      const referee = await customer();
      const codeA = await codeOf(first);
      const codeB = await codeOf(second);

      const [a, b] = await Promise.all([claim(referee, codeA), claim(referee, codeB)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);

      const rows = await storedAttributions();
      expect(rows).toHaveLength(1);
      // Exactly one of the two, and which one is a genuine race -- the point is
      // that the OTHER did not overwrite it.
      expect([first.id, second.id]).toContain(rows[0].referrer_user_id);

      const winner = rows[0].referrer_user_id;
      // Replaying the loser's code changes nothing.
      await claim(referee, winner === first.id ? codeB : codeA).expect(409);
      const after = await storedAttributions();
      expect(after).toHaveLength(1);
      expect(after[0].referrer_user_id).toBe(winner);
    });

    it('a replay cannot change the original referrer', async () => {
      const referrer = await customer();
      const other = await customer();
      const referee = await customer();

      await claim(referee, await codeOf(referrer)).expect(200);
      const before = (await storedAttributions())[0];

      for (let i = 0; i < 3; i += 1) {
        await claim(referee, await codeOf(other)).expect(409);
        await claim(referee, await codeOf(referrer)).expect(409);
      }

      const after = await storedAttributions();
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(before);
    });

    it('rejects self-referral through a RAW INSERT, bypassing the service entirely', async () => {
      // The guarantee is the CHECK constraint, not the service branch. A test
      // that only went through the route would prove the branch works and say
      // nothing about whether the constraint exists.
      const user = await customer();

      await expect(
        dataSource.query(
          `INSERT INTO referral.referrals
             (id, referrer_user_id, referee_user_id, referral_code_id, attributed_at, expires_at)
           VALUES ($1, $2, $2, $3, now(), now() + interval '90 days')`,
          [uuidv7(), user.id, uuidv7()],
        ),
      ).rejects.toThrow(/ck_referrals_no_self/);
    });

    it('rejects a second attribution through a RAW INSERT', async () => {
      const referrer = await customer();
      const other = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      await expect(
        dataSource.query(
          `INSERT INTO referral.referrals
             (id, referrer_user_id, referee_user_id, referral_code_id, attributed_at, expires_at)
           VALUES ($1, $2, $3, $4, now(), now() + interval '90 days')`,
          [uuidv7(), other.id, referee.id, uuidv7()],
        ),
      ).rejects.toThrow(/uq_referrals_referee/);
    });

    it('refuses to REWRITE an attribution through raw SQL — all four frozen columns', async () => {
      // ADR-036 §3. "No route does that" is the guarantee that decays the first
      // time somebody adds an admin surface, so the database refuses instead.
      const referrer = await customer();
      const other = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      const rewrites: Array<[string, unknown[]]> = [
        ['UPDATE referral.referrals SET referrer_user_id = $1', [other.id]],
        ['UPDATE referral.referrals SET referee_user_id = $1', [other.id]],
        ['UPDATE referral.referrals SET referral_code_id = $1', [uuidv7()]],
        ['UPDATE referral.referrals SET attributed_at = now()', []],
      ];

      for (const [statement, parameters] of rewrites) {
        await expect(dataSource.query(statement, parameters)).rejects.toThrow(/immutable/i);
      }

      // Untouched.
      const [row] = await storedAttributions();
      expect(row.referrer_user_id).toBe(referrer.id);
      expect(row.referee_user_id).toBe(referee.id);
    });

    it('still ALLOWS the tombstone columns to be written', async () => {
      // The other half of the trigger, and the reason a blanket REVOKE UPDATE
      // could not be used: erasure must be able to stamp these two.
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      await expect(
        dataSource.query('UPDATE referral.referrals SET referrer_erased_at = now()'),
      ).resolves.toBeDefined();
      await expect(
        dataSource.query('UPDATE referral.referrals SET referee_erased_at = now()'),
      ).resolves.toBeDefined();
    });

    it('exposes NO service or route capable of rewriting an attribution', async () => {
      // Structural, and the complement of the trigger cases. The database would
      // refuse a rewrite -- this asserts nothing in the module even tries, so a
      // reviewer does not have to trust that the trigger is the only guard.
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(referral));
      for (const method of methods) {
        expect(method).not.toMatch(/update|rewrite|reassign|transfer|setReferrer|revoke|correct/i);
      }
    });
  });

  // ==========================================================================
  // 8. Privacy — export, erasure, tombstones, coverage
  // ==========================================================================

  describe('privacy', () => {
    const contractsOf = () => app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
    const referralContract = () => contractsOf().find((contract) => contract.moduleKey === 'referral')!;

    async function exportFor(userId: string) {
      return dataSource.transaction((manager) => referralContract().exportSubjectData(manager, userId));
    }

    it('claims all three tables at boot, against the REAL catalogue', async () => {
      const catalogue: Array<{ table_schema: string; table_name: string }> = await dataSource.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_schema = 'referral' AND table_type = 'BASE TABLE'`,
      );
      const real = catalogue.map((row) => `${row.table_schema}.${row.table_name}`).sort();
      expect(real).toEqual(['referral.claim_attempts', 'referral.referral_codes', 'referral.referrals']);

      const claims = referralContract().tables.map((claim) => claim.table).sort();
      expect(claims).toEqual(real);

      // And the dispositions are the ones `V32-DEC-019` ratified.
      const byTable = new Map(referralContract().tables.map((claim) => [claim.table, claim]));
      expect(byTable.get('referral.referral_codes')!.disposition).toBe('subject_data');
      expect(byTable.get('referral.claim_attempts')!.disposition).toBe('subject_data');
      expect(byTable.get('referral.referrals')!.disposition).toBe('retained');
      // `retained` is one of the two dispositions that EXCUSE a table from
      // erasure, so ADR-027 requires a reason.
      expect(byTable.get('referral.referrals')!.reason).toBeTruthy();
    });

    /**
     * The catalogue the REAL boot-time check reads.
     *
     * Deliberately `SubjectDataCoverageService.readCatalogue()` rather than a
     * hand-written `information_schema` query. A first version of this file did
     * write its own, and it was wrong in two ways at once that a passing test
     * would have hidden: `information_schema.tables` shows only what the
     * connecting role may see, so `financial.*` was invisible to
     * `beauclick_app`, and excluding `public` dropped `schema_migrations`, which
     * `privacy` legitimately claims.
     *
     * The consequence is the important part: those omissions made the catalogue
     * SMALLER, so a table this story failed to claim could have gone unnoticed.
     * A coverage test that builds its own catalogue is testing its own query.
     */
    const coverage = () => app.get(SubjectDataCoverageService);

    async function referralCatalogue() {
      const full = await coverage().readCatalogue();
      return full.filter((table) => table.schema === 'referral');
    }

    it('passes the REAL boot-time coverage check over the whole catalogue', async () => {
      // The same call `assertComplete` makes at boot, over the same catalogue.
      // If Story #27's two new tables were unclaimed, the application would not
      // start -- so this is the check, not a re-implementation of it.
      const result = await coverage().evaluate(contractsOf());
      expect(result.violations).toEqual([]);
      expect(result.tablesInDatabase).toBeGreaterThan(0);
    });

    it('assertComplete() actually passes, and the referral tables are IN the catalogue it read', async () => {
      // `assertComplete` returns null and only WARNS when the catalogue comes
      // back empty -- so "it did not throw" is not by itself evidence. The
      // second assertion is what makes the first non-vacuous.
      await expect(coverage().assertComplete(contractsOf())).resolves.not.toBeNull();

      const names = (await coverage().readCatalogue()).map((table) => `${table.schema}.${table.name}`);
      expect(names).toContain('referral.referrals');
      expect(names).toContain('referral.claim_attempts');
      expect(names).toContain('referral.referral_codes');
    });

    it('is non-vacuous: an UNCLAIMED referral table fails coverage', async () => {
      // The guard for the case above. Without it, `evaluateCoverage` returning
      // `[]` could mean "everything is claimed" or "the checker does nothing".
      //
      // Note this ALSO proves the `_user_id` naming heuristic bites: the
      // stripped table carries `referrer_user_id` and `referee_user_id`, so it
      // is caught as subject-shaped rather than merely as unclaimed.
      const stripped: SubjectDataContract[] = contractsOf().map((contract) =>
        contract.moduleKey === 'referral'
          ? { ...contract, tables: contract.tables.filter((claim) => claim.table !== 'referral.referrals') }
          : contract,
      );
      const result = evaluateCoverage(await referralCatalogue(), stripped);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.violations)).toContain('referrals');
    });

    it('is non-vacuous: a claim for an ABSENT table fails coverage', async () => {
      // The converse violation -- a stale claim reads as coverage while
      // covering nothing, which ADR-027 calls out as worse than no claim. It is
      // also exactly the mistake this story could have made by claiming
      // `reward_grants` and `referrer_counters` from `V32-DEC-019`'s table
      // before Stories #12 and #28 create them.
      const inflated: SubjectDataContract[] = contractsOf().map((contract) =>
        contract.moduleKey === 'referral'
          ? {
              ...contract,
              tables: [
                ...contract.tables,
                { table: 'referral.reward_grants', disposition: 'retained' as const, reason: 'not built yet' },
              ],
            }
          : contract,
      );
      const result = evaluateCoverage(await referralCatalogue(), inflated);
      expect(JSON.stringify(result.violations)).toContain('reward_grants');
    });

    it("exports the REFERRER's own facts and no referee identity", async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      await claim(referee, code).expect(200);

      const sections = await exportFor(referrer.id);
      const made = sections.find((section) => section.key === 'referrals_made')!;
      expect(made.rows).toHaveLength(1);
      expect(Object.keys(made.rows[0]).sort()).toEqual(['attributedAt', 'expiresAt', 'refereeErased']);

      const serialised = JSON.stringify(sections);
      expect(serialised).not.toContain(referee.id);
      expect(serialised).not.toContain(referee.phone);
      // The referrer's OWN code is present and that is correct -- it is their
      // own credential going to them (`V32-DEC-019`).
      expect(serialised).toContain(code);
    });

    it("exports the REFEREE's own fact and NEVER the referrer's code", async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      await claim(referee, code).expect(200);

      const sections = await exportFor(referee.id);
      const received = sections.find((section) => section.key === 'referral_received')!;
      expect(received.rows).toHaveLength(1);
      expect(Object.keys(received.rows[0]).sort()).toEqual(['attributedAt', 'expiresAt', 'referrerErased']);

      const serialised = JSON.stringify(sections);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(referrer.id);
      expect(serialised).not.toContain(referrer.phone);
    });

    it('leaks no internal eligibility reason into any export', async () => {
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);
      // Generate refusals too, so anything that recorded a cause would have
      // something to record.
      await claim(referee, await codeOf(await customer())).expect(409);

      for (const subject of [referrer, referee]) {
        const serialised = JSON.stringify(await exportFor(subject.id)).toLowerCase();
        for (const cause of ['too_old', 'already_attributed', 'own_code', 'unknown_code', 'already_booked', 'reason', 'refus']) {
          expect(serialised).not.toContain(cause);
        }
      }
    });

    it('tombstones the REFERRER on their erasure and keeps the referee coherent', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      await claim(referee, code).expect(200);

      const outcome = await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, referrer.id, {
          userId: referrer.id,
          phoneAlias: `del:${referrer.id.replace(/-/g, '').slice(0, 26)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
      );

      // The relationship SURVIVES -- it explains a loyalty entry the referee
      // still holds -- and is reported honestly as retained.
      const rows = await storedAttributions();
      expect(rows).toHaveLength(1);
      expect(rows[0].referrer_erased_at).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(rows[0].referee_erased_at).toBeNull();
      expect(outcome.anonymized).toBe(1);
      expect(outcome.retained.map((entry) => entry.table)).toEqual(['referral.referrals']);

      // The referrer's CODE is destroyed, so it can no longer be claimed --
      // which is the point of the different disposition (`V32-DEC-019`).
      expect(await dataSource.query('SELECT 1 FROM referral.referral_codes WHERE code = $1', [code])).toHaveLength(0);
      await claim(await customer(), code).expect(409);

      // The referee's export still coheres: they were invited, and the other
      // side is marked erased rather than silently missing.
      const received = (await exportFor(referee.id)).find((section) => section.key === 'referral_received')!;
      expect(received.rows[0]).toMatchObject({ referrerErased: true });
    });

    it('tombstones the REFEREE on their erasure and keeps the referrer coherent', async () => {
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      const outcome = await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, referee.id, {
          userId: referee.id,
          phoneAlias: `del:${referee.id.replace(/-/g, '').slice(0, 26)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date('2026-07-02T00:00:00.000Z'),
        }),
      );

      const rows = await storedAttributions();
      expect(rows).toHaveLength(1);
      expect(rows[0].referee_erased_at).toEqual(new Date('2026-07-02T00:00:00.000Z'));
      expect(rows[0].referrer_erased_at).toBeNull();
      expect(outcome.anonymized).toBe(1);

      const made = (await exportFor(referrer.id)).find((section) => section.key === 'referrals_made')!;
      expect(made.rows[0]).toMatchObject({ refereeErased: true });
    });

    it('handles BOTH sides erasing, and stays coherent', async () => {
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      for (const [subject, at] of [
        [referrer, '2026-07-01T00:00:00.000Z'],
        [referee, '2026-07-02T00:00:00.000Z'],
      ] as const) {
        await dataSource.transaction((manager) =>
          referralContract().eraseSubjectData(manager, subject.id, {
            userId: subject.id,
            phoneAlias: `del:${subject.id.replace(/-/g, '').slice(0, 26)}`,
            displayAlias: 'کاربر حذف‌شده',
            erasedAt: new Date(at),
          }),
        );
      }

      const rows = await storedAttributions();
      expect(rows).toHaveLength(1);
      expect(rows[0].referrer_erased_at).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(rows[0].referee_erased_at).toEqual(new Date('2026-07-02T00:00:00.000Z'));
      // Nothing but ids and instants remain, and both sides are marked.
      expect(await dataSource.query('SELECT 1 FROM referral.referral_codes')).toHaveLength(0);
    });

    it('erasure is idempotent — a second pass moves no timestamp', async () => {
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      const erase = (at: string) =>
        dataSource.transaction((manager) =>
          referralContract().eraseSubjectData(manager, referrer.id, {
            userId: referrer.id,
            phoneAlias: `del:${referrer.id.replace(/-/g, '').slice(0, 26)}`,
            displayAlias: 'کاربر حذف‌شده',
            erasedAt: new Date(at),
          }),
        );

      await erase('2026-07-01T00:00:00.000Z');
      const second = await erase('2026-08-01T00:00:00.000Z');

      expect(second.anonymized).toBe(0);
      const [row] = await storedAttributions();
      // Still the FIRST instant. A moved timestamp would misreport when the
      // subject was erased.
      expect(row.referrer_erased_at).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('DELETES the claim-attempt counters on erasure', async () => {
      const referee = await customer();
      await claim(referee, 'ZZZZZZZZZZ').expect(409);
      expect(
        await dataSource.query('SELECT 1 FROM referral.claim_attempts WHERE claimant_user_id = $1', [referee.id]),
      ).toHaveLength(1);

      await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, referee.id, {
          userId: referee.id,
          phoneAlias: `del:${referee.id.replace(/-/g, '').slice(0, 26)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date(),
        }),
      );

      expect(
        await dataSource.query('SELECT 1 FROM referral.claim_attempts WHERE claimant_user_id = $1', [referee.id]),
      ).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 9. The event, analytics, notification, metric, and log boundary
  // ==========================================================================

  describe('the emission boundary', () => {
    it('defines NO ReferralAttributed event anywhere in the contract catalogue', async () => {
      // `V32-DEC-033`, ADR-036 §10: it has no consumer. Story #12 qualifies on
      // `BookingCompleted`, not on an attribution event.
      const names = ALL_EVENT_CONTRACTS.map((contract) => contract.name);
      expect(names).not.toContain('ReferralAttributed');
      for (const name of names) {
        expect(name).not.toMatch(/ReferralAttributed|ReferralClaimed/);
      }
    });

    it('has no referral outbox table at all', async () => {
      expect(
        await dataSource.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'referral' AND table_name = 'outbox_events'`,
        ),
      ).toHaveLength(0);
    });

    it('writes the code into NO outbox, notification, analytics table, or log', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const { args, output } = await recordLogging(async () => {
        await claim(referee, code).expect(200);
        // Refusals too -- an exception path is the most likely place a code
        // gets interpolated into a message.
        await claim(referee, code).expect(409);
        await claim(await customer(), 'ZZZZZZZZZZ').expect(409);
      });

      expect(args).not.toContain(code);
      expect(output).not.toContain(code);

      const outboxes: Array<{ table_schema: string; table_name: string }> = await dataSource.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_name IN ('outbox_events','notifications','events')
            AND table_schema NOT IN ('pg_catalog','information_schema')`,
      );
      for (const table of outboxes) {
        const rows = await dataSource.query(
          `SELECT * FROM ${table.table_schema}.${table.table_name}`,
        );
        expect(JSON.stringify(rows)).not.toContain(code);
      }
    });

    it('is NON-VACUOUS: the same detectors find a PLANTED code', async () => {
      // The guard. Without it, the case above passes if `recordLogging` captures
      // nothing and the tables are empty -- which is exactly the failure mode
      // `referral.pg-spec`'s docblock records having hit once already.
      const planted = 'PLANTED123';

      // (a) The log detector must see a value that IS logged, through the same
      // capture path.
      const { args, output } = await recordLogging(async () => {
        new Logger('NonVacuityProbe').log(`probe ${planted}`);
      });
      expect(args).toContain(planted);
      expect(output.length + args.length).toBeGreaterThan(0);

      // (b) The table scanner must see a value that IS in a scanned table,
      // found by the SAME enumerate-then-stringify path the real case uses --
      // not by a hand-written SELECT that could differ from it.
      const referee = await customer();
      await dataSource.query(
        `INSERT INTO notification.notifications
           (id, user_id, category, template_key, channel, payload, idempotency_key, entity_type, entity_id)
         VALUES ($1, $2, 'privacy', 'probe.template', 'in_app', $3::jsonb, $4, 'probe', $5)`,
        [uuidv7(), referee.id, JSON.stringify({ probe: planted }), `probe-${planted}`, uuidv7()],
      );

      const scanned: string[] = [];
      const tables: Array<{ table_schema: string; table_name: string }> = await dataSource.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_name IN ('outbox_events','notifications','events')
            AND table_schema NOT IN ('pg_catalog','information_schema')`,
      );
      for (const table of tables) {
        scanned.push(JSON.stringify(await dataSource.query(`SELECT * FROM ${table.table_schema}.${table.table_name}`)));
      }

      expect(tables.length).toBeGreaterThan(0);
      expect(scanned.join('')).toContain(planted);
    });

    it('exposes no reward, qualification, or reversal API', async () => {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(referral));
      for (const method of methods) {
        expect(method).not.toMatch(/reward|qualif|revers|clawback|grant|points|cap(?!tured)/i);
      }
    });
  });
});
