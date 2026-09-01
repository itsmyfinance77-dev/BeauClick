import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';
import { z } from 'zod';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, tombstoneFor } from '@beauclick/subject-data';
import { ALL_EVENT_CONTRACTS } from '@beauclick/event-contracts';
import { LOYALTY_POLICY_DEFAULTS, LoyaltyLedgerService } from '@beauclick/loyalty';
import { MetricsRegistry } from '@beauclick/observability';
import { PrivacyService } from '@beauclick/privacy';
import { OrderService } from '@beauclick/commerce';
import {
  REFERRAL_CLAIM_ATTEMPTS_PER_HOUR,
  REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS,
  REFERRAL_CLAIM_REFUSED_CODE,
} from '@beauclick/referral-contract';
import {
  REFERRAL_MONTHLY_CAP,
  REFERRAL_REWARD_CONFIG,
  REFERRAL_REWARD_DEFAULTS,
  ReferralQualificationService,
  ReferralRewardConfig,
  ReferralReversalService,
  ReferralService,
  ReferralSubjectDataContract,
  tehranCalendarMonth,
} from '@beauclick/referral';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

const DAY_MS = 86_400_000;
const ORDER_TOTAL = 400_000;

/**
 * The referral abuse, security and concurrency adversarial suite — V3.2-C
 * Story #13 (`V32-DEC-016` … `V32-DEC-019`, `V32-DEC-033` … `V32-DEC-036`;
 * ADR-035, ADR-036, ADR-037, ADR-038).
 *
 * ## What this file is FOR, and what it deliberately does not repeat
 *
 * Stories #11, #27, #12 and #28 each shipped their own real-PostgreSQL suite,
 * and each proves the rules **that story introduced**. Those files are not
 * duplicated here: re-asserting `uq_referrals_referee` in a fifth place would
 * add a maintenance cost and no evidence.
 *
 * This suite owns the three things none of them can:
 *
 *  1. **The gaps.** Five closed rules had no test at all, and §0's matrix names
 *     each one against the section that now proves it.
 *  2. **The CROSS-STORY abuse chains.** An attacker does not stay inside one
 *     story. Claim → qualify → refund → re-claim spans four suites, and the
 *     interesting failures live exactly at the seams none of them owns.
 *  3. **Cross-owner isolation as a domain-wide property.** Each story proved
 *     its own table was scoped. Nothing proved that *every* referral surface,
 *     taken together, refuses a foreign subject — which is the property an
 *     attacker actually attacks.
 *
 * ## §0. The contract-to-test matrix
 *
 * Every closed rule, and where its named positive and negative cases live.
 * `here` means this file; a story suite name means the rule is already proved
 * there and is deliberately not re-proved.
 *
 * | Rule | Decision | Positive | Negative |
 * |---|---|---|---|
 * | Self-referral unrepresentable | `V32-DEC-019` | attribution suite | attribution suite **+ here** (§A1, ordering-independence) |
 * | Refusals indistinguishable | `V32-DEC-019` | attribution suite | attribution suite **+ here** (§A2, near-miss oracle) |
 * | Foreign ownership cannot read/mutate/infer | `V32-DEC-019` | **here** §A3 | **here** §A3 |
 * | Repeated claim replay-safe | `V32-DEC-019` | attribution suite | **here** §A4 |
 * | Simultaneous claims → one attribution | `V32-DEC-019` | **here** §A5 | attribution suite |
 * | Erase-and-re-register is an ACCEPTED, BOUNDED gap | `V32-DEC-019` | **here** §A6 | **here** §A6 |
 * | No device/IP/fingerprint signal | `V32-DEC-019` | — | **here** §A7 |
 * | Only `BookingCompleted` qualifies | `V32-DEC-018` | qualification suite | qualification suite |
 * | Both reward values are exactly ZERO | `V32-DEC-016` | **here** §B1 | **here** §B1 |
 * | Zero consumes NO ledger idempotency slot | `V32-DEC-016` | **here** §B2 | **here** §B2 |
 * | Zero DOES consume a monthly cap slot | `V32-DEC-019` | **here** §B2 | **here** §B2 |
 * | Cap boundary under concurrency (`GAP-04`) | `V32-DEC-019` | qualification suite | qualification suite |
 * | The period is the SOLAR HIJRI month | `V32-DEC-035` | **here** §C1 | **here** §C1 |
 * | A reversal never returns a cap slot | `V32-DEC-036` | reversal suite | reversal suite **+ here** (§D1, the cycling chain) |
 * | Only a FULL refund reverses | `V32-DEC-017` | reversal suite | reversal suite |
 * | No code/phone/name/prose in any sink | `V32-DEC-033` | — | **here** §E1 (metrics) + story suites |
 * | Export asymmetry, both directions | `V32-DEC-019` | attribution suite | **here** §A3 (cross-owner) |
 *
 * ## The non-vacuity discipline
 *
 * Every absence assertion here is paired with a **planted positive** through
 * the same detector and the same path. `referral.pg-spec.ts`'s `recordLogging`
 * docblock records why: an earlier version captured only the process streams
 * and passed while capturing nothing at all. A detector that cannot fail is
 * not evidence, and this file treats "the plant was found" as a precondition
 * of trusting the real assertion rather than as a separate nicety.
 */
describePg('referral — abuse, security and concurrency adversarial suite (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let referral: ReferralService;
  let qualification: ReferralQualificationService;
  let reversal: ReferralReversalService;
  let ledger: LoyaltyLedgerService;
  let orders: OrderService;
  let privacy: PrivacyService;
  let rewards: { referrerPoints: number; refereePoints: number };

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    referral = app.get(ReferralService);
    qualification = app.get(ReferralQualificationService);
    reversal = app.get(ReferralReversalService);
    ledger = app.get(LoyaltyLedgerService);
    orders = app.get(OrderService);
    privacy = app.get(PrivacyService);
    rewards = app.get<ReferralRewardConfig>(REFERRAL_REWARD_CONFIG) as {
      referrerPoints: number;
      refereePoints: number;
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    ctx.referralClock.release();
    restoreRewards();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const http = () => request(app.getHttpServer());

  /**
   * Temporarily overrides the two configured reward values.
   *
   * Identical in mechanism and in reasoning to `referral-qualification.pg-spec`
   * and `referral-reversal.pg-spec`: `REFERRAL_REWARD_CONFIG` is bound at the
   * composition root to an object with GETTERS onto `LoyaltyConfig.policy`, so
   * it cannot simply be assigned.
   *
   * **The paying path is proved by injecting here and never by editing the
   * default.** `V32-DEC-016` set both production values to 0; a test that moved
   * the constant to make ledger rows appear would be inventing economics no
   * owner approved, and §B1 exists specifically to catch that happening.
   */
  const originalDescriptors = new Map<string, PropertyDescriptor>();

  function withRewards(referrerPoints: number, refereePoints: number): void {
    for (const [key, value] of [
      ['referrerPoints', referrerPoints],
      ['refereePoints', refereePoints],
    ] as const) {
      if (!originalDescriptors.has(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(rewards, key);
        if (descriptor) originalDescriptors.set(key, descriptor);
      }
      Object.defineProperty(rewards, key, { value, configurable: true, enumerable: true });
    }
  }

  function restoreRewards(): void {
    for (const [key, descriptor] of originalDescriptors) {
      Object.defineProperty(rewards, key, descriptor);
    }
    originalDescriptors.clear();
  }

  let seq = 0;
  async function customer(phone?: string): Promise<SeededUser> {
    seq += 1;
    return seedUser(app, dataSource, phone ?? `+9891790${String(seq).padStart(5, '0')}`);
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

  /** A pending attribution written directly — the claim route has its own suite. */
  async function pendingReferral(referrer: SeededUser, referee: SeededUser): Promise<string> {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO referral.referrals
         (id, referrer_user_id, referee_user_id, referral_code_id, attributed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, referrer.id, referee.id, uuidv7(), new Date(Date.now() - DAY_MS), new Date(Date.now() + 89 * DAY_MS)],
    );
    return id;
  }

  /**
   * A PAID booking order, written directly.
   *
   * Refunds are then applied through `OrderService.recordRefund`, never by
   * writing a status here — ADR-038 §2's whole point is that the platform's own
   * statement computes full-versus-partial, so a fixture that set
   * `status = 'refunded'` would be asserting against a rule it had bypassed.
   */
  async function paidOrder(bookingId: string, customerId: string, total = ORDER_TOTAL): Promise<string> {
    const orderId = uuidv7();
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, discount_total_toman, fee_total_toman, total_toman, paid_at)
       VALUES ($1, 'booking', $2, $3, 'professional', $4, 'paid', 'IRT', $5, 0, 0, $5, now())`,
      [orderId, bookingId, customerId, uuidv7(), total],
    );
    return orderId;
  }

  /** Qualification, exactly as the handler runs it: one transaction, caller's manager. */
  async function qualifyFor(referee: SeededUser, bookingId = uuidv7()) {
    return dataSource.transaction((manager) =>
      qualification.qualify(manager, { refereeUserId: referee.id, bookingId }),
    );
  }

  /** Reversal, exactly as the `OrderRefunded` handler runs it. */
  async function reverseFor(orderId: string) {
    return dataSource.transaction((manager) => reversal.reverseForRefundedOrder(manager, orderId));
  }

  async function referralRows() {
    return dataSource.query(
      'SELECT id, referrer_user_id, referee_user_id, status FROM referral.referrals ORDER BY attributed_at, id',
    ) as Promise<Array<{ id: string; referrer_user_id: string; referee_user_id: string; status: string }>>;
  }

  async function counters(referrerUserId: string) {
    return dataSource.query(
      'SELECT period, qualified_count FROM referral.referrer_counters WHERE referrer_user_id = $1 ORDER BY period',
      [referrerUserId],
    ) as Promise<Array<{ period: string; qualified_count: number }>>;
  }

  async function ledgerRows(referralId: string) {
    return dataSource.query(
      `SELECT user_id, points, base_points, reason FROM loyalty.points_entries
        WHERE reference_type = 'referral' AND reference_id = $1 ORDER BY reason`,
      [referralId],
    ) as Promise<Array<{ user_id: string; points: number; base_points: number; reason: string }>>;
  }

  const referralContract = () => app.get(ReferralSubjectDataContract);

  async function exportFor(userId: string) {
    return dataSource.transaction((manager) => referralContract().exportSubjectData(manager, userId));
  }

  /**
   * Everything logged while `run` executed, captured two ways.
   *
   * Lifted from `referral.pg-spec.ts` and `referral-attribution.pg-spec.ts`,
   * whose docblocks record why BOTH halves are needed: `args` is the exact
   * material a log line is built from, and `output` covers anything logging
   * outside Nest's `Logger`.
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

  /**
   * Runs the real platform erasure for a subject, through the real route.
   *
   * `POST /api/v1/privacy/deletion` then a backdated `execute_after` then
   * `executeErasure` — which is the sweep's own path (`PrivacySweepService`
   * calls the same method), so every registered module runs in one transaction
   * exactly as it would in production.
   *
   * Going through the platform rather than calling `ReferralSubjectDataContract`
   * directly is the whole point of §A6: the accepted gap is a property of what
   * **identity** does to the phone number, and a referral-only erasure would
   * leave the number occupied and prove the opposite of what is claimed.
   */
  async function eraseSubjectThroughThePlatform(user: SeededUser): Promise<void> {
    const created = await http()
      .post('/api/v1/privacy/deletion')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ confirm: 'DELETE' })
      .expect(202);

    // The approved grace window (`PRIVACY_ERASURE_GRACE_HOURS`, 168h by
    // default) is moved into the past rather than waited out. The window is
    // not what is under test here; what happens AFTER it closes is.
    await dataSource.query(
      `UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`,
      [created.body.data.id],
    );

    const outcomes = await privacy.executeErasure(created.body.data.id as string);
    expect(outcomes).not.toBeNull();
  }

  // ==========================================================================
  // A. ATTRIBUTION AND OWNERSHIP
  // ==========================================================================

  describe('A1 — self-referral', () => {
    it('POSITIVE: a foreign code is attributed normally, which is the control', async () => {
      const referrer = await customer();
      const referee = await customer();

      await claim(referee, await codeOf(referrer)).expect(200);

      const rows = await referralRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ referrer_user_id: referrer.id, referee_user_id: referee.id });
    });

    it('NEGATIVE: is refused even when the caller is otherwise PERFECTLY eligible', async () => {
      // The eligibility list is evaluated in a fixed order (ADR-036 §4), and a
      // self-referral refusal that only happened to fire because some OTHER
      // condition failed first would be a guarantee nobody actually has. This
      // caller is brand new, has no booking, has never been attributed, and has
      // a full throttle budget: the ONLY thing wrong is that the code is theirs.
      const attacker = await customer();
      const own = await codeOf(attacker);

      const response = await claim(attacker, own).expect(409);
      expect(response.body.error).toEqual({ code: REFERRAL_CLAIM_REFUSED_CODE, message: expect.any(String) });
      expect(await referralRows()).toHaveLength(0);
    });

    it('NEGATIVE: is refused for a caller who ALSO holds a perfectly valid foreign code', async () => {
      // The sharpest form. If self-referral were refused by accident -- say by
      // an eligibility read that returned nothing for a reason unrelated to
      // ownership -- then the same caller would also fail with a foreign code.
      // They do not: the foreign claim succeeds immediately afterwards, so the
      // refusal above was about WHOSE code it was and nothing else.
      const attacker = await customer();
      const friend = await customer();
      const own = await codeOf(attacker);
      const foreign = await codeOf(friend);

      await claim(attacker, own).expect(409);
      expect(await referralRows()).toHaveLength(0);

      await claim(attacker, foreign).expect(200);
      const rows = await referralRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].referrer_user_id).toBe(friend.id);
    });

    it('NEGATIVE: cannot be reached by MUTATING a legitimate attribution into a self-referral', async () => {
      // `ck_referrals_no_self` is a CHECK on INSERT and the frozen-column
      // trigger guards UPDATE. Neither alone would stop an attacker with SQL
      // access from converting somebody else's referral into a self-referral,
      // so both are exercised against an already-committed row.
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);
      const [row] = await referralRows();

      await expect(
        dataSource.query('UPDATE referral.referrals SET referrer_user_id = referee_user_id WHERE id = $1', [row.id]),
      ).rejects.toThrow();

      // Untouched: still two distinct parties.
      const [after] = await referralRows();
      expect(after.referrer_user_id).toBe(referrer.id);
      expect(after.referee_user_id).toBe(referee.id);
    });
  });

  describe('A2 — a forged or unknown code is indistinguishable', () => {
    /**
     * The six enumerated eligibility failures (`V32-DEC-019`, ADR-036 §8),
     * built so each one fails for exactly one reason.
     */
    async function sixRefusalBodies(): Promise<Array<{ label: string; body: unknown }>> {
      const bodies: Array<{ label: string; body: unknown }> = [];

      // 1. A code that has never existed.
      bodies.push({ label: 'unknown code', body: (await claim(await customer(), 'ZZZZZZZZZZ').expect(409)).body });

      // 2. A code whose owner was erased, so the row is GONE -- ADR-036 §4's
      //    "revoked code" case, which resolves to an absent row by construction.
      const erasedOwner = await customer();
      const revoked = await codeOf(erasedOwner);
      await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, erasedOwner.id, tombstoneFor(erasedOwner.id, new Date())),
      );
      bodies.push({ label: 'revoked code', body: (await claim(await customer(), revoked).expect(409)).body });

      // 3. The caller's own code.
      const selfie = await customer();
      bodies.push({ label: 'own code', body: (await claim(selfie, await codeOf(selfie)).expect(409)).body });

      // 4. Already attributed.
      const attributed = await customer();
      await claim(attributed, await codeOf(await customer())).expect(200);
      bodies.push({
        label: 'already attributed',
        body: (await claim(attributed, await codeOf(await customer())).expect(409)).body,
      });

      // 5. Account older than the claim window.
      const old = await customer();
      await dataSource.query(
        'UPDATE identity.users SET created_at = created_at - $2::interval WHERE id = $1',
        [old.id, `${REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS + 1} days`],
      );
      bodies.push({ label: 'account too old', body: (await claim(old, await codeOf(await customer())).expect(409)).body });

      // 6. A malformed code -- folded into the same refusal rather than
      //    validated at the edge, because the edge echoed the credential
      //    (ADR-036 §1, `ReferralClaimDto`'s docblock).
      bodies.push({ label: 'malformed code', body: (await claim(await customer(), 'not-a-code!!').expect(409)).body });

      return bodies;
    }

    it('NEGATIVE: every refusal body is byte-identical across all six cases', async () => {
      const bodies = await sixRefusalBodies();
      const first = bodies[0].body;

      for (const { label, body } of bodies) {
        // Whole bodies, not status codes. A status-only assertion passes while
        // a `details.reason` leaks the branch, which is the failure this exists
        // to catch (ADR-036 §8).
        expect({ label, body }).toEqual({ label, body: first });
      }
      // Structural rather than a regex over the serialised envelope: the error
      // object carries EXACTLY `code` and `message` and no third key, so there
      // is no `reason`, `details`, `retryAfter` or discriminator of any kind for
      // a branch to leak through. `ReferralClaimRefusedException` takes no
      // arguments, which is what makes that true by construction (ADR-036 §8).
      const error = (first as { error: Record<string, unknown> }).error;
      expect(Object.keys(error).sort()).toEqual(['code', 'message']);
      expect((first as { data: unknown; meta: unknown }).data).toBeNull();
      expect((first as { data: unknown; meta: unknown }).meta).toBeNull();
    });

    it('NEGATIVE: a NEAR-MISS of a real code answers identically to pure garbage', async () => {
      // The oracle an attacker actually builds. They hold a code that is one
      // character off a real one -- from a screenshot, a misread, a partial
      // leak -- and want to know whether they are close. A response that
      // differed at all between "one character wrong" and "wholly invented"
      // would turn the route into a hill-climbing oracle over the keyspace.
      const owner = await customer();
      const real = await codeOf(owner);

      // Same length, same alphabet, one character different: still not a code.
      const alphabetOther = real[0] === 'A' ? 'B' : 'A';
      const nearMiss = alphabetOther + real.slice(1);
      expect(nearMiss).not.toBe(real);

      const near = await claim(await customer(), nearMiss).expect(409);
      const garbage = await claim(await customer(), 'ZZZZZZZZZZ').expect(409);

      expect(near.body).toEqual(garbage.body);
      expect(near.headers['content-length']).toBe(garbage.headers['content-length']);
    });

    it('POSITIVE non-vacuity: the comparison DOES detect a real difference', async () => {
      // The body comparison above is the load-bearing assertion in this group.
      // If `toEqual` were comparing two things that are always equal -- an
      // empty body, say -- every case above would pass while proving nothing.
      const refused = (await claim(await customer(), 'ZZZZZZZZZZ').expect(409)).body;
      const accepted = (await claim(await customer(), await codeOf(await customer())).expect(200)).body;

      expect(refused).not.toEqual(accepted);
    });

    it('NEGATIVE: 429 and 400 are OUTSIDE the collapsed set, by decision', async () => {
      // `V32-DEC-019` enumerates six cases and stops. Throttle exhaustion is a
      // fact about how many requests the CALLER just made -- which they already
      // know, and which reveals nothing about any code, account, or owner -- and
      // ADR-036 §6(c) records why folding it in would be actively worse: it
      // would tell an attacker who spent ten guesses that all ten were wrong.
      const attacker = await customer();
      for (let i = 0; i < REFERRAL_CLAIM_ATTEMPTS_PER_HOUR; i += 1) {
        await claim(attacker, 'ZZZZZZZZZZ').expect(409);
      }
      const throttled = await claim(attacker, 'ZZZZZZZZZZ').expect(429);
      expect(throttled.body.code).not.toBe(REFERRAL_CLAIM_REFUSED_CODE);

      // And a forged field is a 400 rather than a silent drop or a refusal.
      const forged = await claim(await customer(), 'ZZZZZZZZZZ', { refereeUserId: uuidv7() }).expect(400);
      expect(forged.body.code).not.toBe(REFERRAL_CLAIM_REFUSED_CODE);
    });
  });

  describe('A3 — foreign ownership cannot read, mutate or infer another referral', () => {
    /**
     * Two complete, unrelated referral histories.
     *
     * `victim` has everything the domain can hold: a code, an attribution they
     * made, a qualification, both grants, a cap counter and a reversal.
     * `attacker` has a code and nothing else. Every case below asks whether any
     * surface will show the attacker something of the victim's.
     */
    async function twoWorlds() {
      const victim = await customer();
      const victimReferee = await customer();
      const attacker = await customer();

      await claim(victimReferee, await codeOf(victim)).expect(200);
      const [{ id: referralId }] = await referralRows();

      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, victimReferee.id);
      withRewards(50, 30);
      expect((await qualifyFor(victimReferee, bookingId)).qualified).toBe(true);

      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());
      await reverseFor(orderId);

      const attackerCode = await codeOf(attacker);
      return { victim, victimReferee, attacker, attackerCode, referralId, orderId };
    }

    it('POSITIVE: the victim can read their OWN referral facts, which is the control', async () => {
      // Without this, every negative below could pass because the accessors
      // return nothing to anybody.
      const { victim, referralId } = await twoWorlds();

      const sections = await exportFor(victim.id);
      const made = sections.find((s) => s.key === 'referrals_made');
      expect(made?.rows.length).toBe(1);
      expect(await ledgerRows(referralId)).not.toHaveLength(0);
      expect(await counters(victim.id)).toHaveLength(1);
    });

    it('NEGATIVE: no service accessor returns a foreign subject a single row', async () => {
      // Every subject-scoped accessor the domain exposes, named individually so
      // one added later without scoping is a compile error here rather than a
      // silent hole. `allForSubject`, `attributionsForSubject`,
      // `rewardGrantsForSubject` and `rewardReversalsForSubject` are the four
      // read paths `ReferralSubjectDataContract` composes an export from.
      const { victim, attacker } = await twoWorlds();

      await dataSource.transaction(async (manager) => {
        expect(await referral.allForSubject(manager, attacker.id)).toHaveLength(1); // their OWN code

        // `attributionsForSubject` answers BOTH directions, and both must be
        // empty: a foreign subject is neither the referrer nor the referee of
        // anything the victim owns.
        const attackerAttributions = await referral.attributionsForSubject(manager, attacker.id);
        expect(attackerAttributions.asReferrer).toHaveLength(0);
        expect(attackerAttributions.asReferee).toHaveLength(0);
        expect(await referral.rewardGrantsForSubject(manager, attacker.id)).toHaveLength(0);
        expect(await referral.rewardReversalsForSubject(manager, attacker.id)).toHaveLength(0);

        // The victim's own rows exist -- so the emptiness above is scoping, not
        // an empty database.
        const victimAttributions = await referral.attributionsForSubject(manager, victim.id);
        expect(victimAttributions.asReferrer).toHaveLength(1);
        expect(victimAttributions.asReferee).toHaveLength(0);
        expect(await referral.rewardGrantsForSubject(manager, victim.id)).toHaveLength(1);
        expect(await referral.rewardReversalsForSubject(manager, victim.id)).toHaveLength(1);
      });
    });

    it('NEGATIVE: the attacker\'s EXPORT contains no identifier belonging to the victim', async () => {
      // Serialised whole and searched for every one of the victim's
      // identifiers. A field-by-field assertion would miss a value that appeared
      // somewhere nobody thought to look.
      const { victim, victimReferee, attacker, referralId, orderId } = await twoWorlds();
      const victimCode = (await exportFor(victim.id)).find((s) => s.key === 'referral_codes')!.rows[0].code as string;

      const serialised = JSON.stringify(await exportFor(attacker.id));
      for (const secret of [
        victim.id,
        victimReferee.id,
        victim.phone,
        victimReferee.phone,
        referralId,
        orderId,
        victimCode, // the victim's BEARER CREDENTIAL, the sharpest of the set
      ]) {
        expect(serialised).not.toContain(secret);
      }
    });

    it('NEGATIVE non-vacuity: the SAME scan finds the victim\'s identifiers in the VICTIM\'s export', async () => {
      // The plant. If `exportFor` returned an empty document, or if the scan
      // looked at the wrong string, the case above would pass while checking
      // nothing at all.
      // The plant is the victim's own CODE, because that is the one value the
      // export is REQUIRED to carry to its own subject (`V32-DEC-019`) and is
      // therefore guaranteed to be findable if the scan works at all. The
      // referral id is deliberately NOT used: no export carries one, so a scan
      // for it would pass against an empty document.
      const { victim } = await twoWorlds();
      const sections = await exportFor(victim.id);
      const victimCode = sections.find((s) => s.key === 'referral_codes')!.rows[0].code as string;

      expect(JSON.stringify(sections)).toContain(victimCode);
    });

    it('NEGATIVE: no HTTP route on the referral surface accepts a foreign subject', async () => {
      // The domain mounts exactly two routes and both are self-scoped, so the
      // adversarial question is whether a foreign id can be smuggled in
      // ANYWHERE -- query string, body, or path. All three are refused rather
      // than ignored, which is the stronger outcome (ADR-036 §1).
      const { victim, attacker, attackerCode } = await twoWorlds();

      await http()
        .get(`/api/v1/me/referral/code?ownerId=${victim.id}`)
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(400);

      await claim(attacker, attackerCode, { refereeUserId: victim.id }).expect(400);
      await claim(attacker, attackerCode, { referrerUserId: victim.id }).expect(400);

      // And there is no addressable-by-id route at all: an attribution has no
      // canonical URL, which is why the claim route returns 200 with no
      // `Location` rather than 201 (ADR-036 §1).
      await http()
        .get(`/api/v1/me/referral/${victim.id}`)
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(404);
    });

    it('NEGATIVE: the attacker cannot INFER how many referrals the victim has', async () => {
      // The count is a fact about other people, derived from rows about other
      // subjects, and `V32-DEC-019` keeps it out of the referrer's own export
      // for that reason -- so it is certainly not available to a stranger.
      //
      // The test is behavioural rather than structural: a victim with a nearly
      // spent cap and a victim with an untouched one must be indistinguishable
      // to somebody claiming their code.
      const busy = await customer();
      const idle = await customer();
      withRewards(0, 0);
      for (let i = 0; i < REFERRAL_MONTHLY_CAP - 1; i += 1) {
        const referee = await customer();
        await pendingReferral(busy, referee);
        await qualifyFor(referee);
      }
      expect((await counters(busy.id))[0].qualified_count).toBe(REFERRAL_MONTHLY_CAP - 1);
      expect(await counters(idle.id)).toHaveLength(0);

      const againstBusy = await claim(await customer(), await codeOf(busy)).expect(200);
      const againstIdle = await claim(await customer(), await codeOf(idle)).expect(200);

      // Identical shapes, and nothing about the referrer in either.
      expect(Object.keys(againstBusy.body.data).sort()).toEqual(Object.keys(againstIdle.body.data).sort());
      expect(JSON.stringify(againstBusy.body)).not.toContain(busy.id);
      expect(JSON.stringify(againstIdle.body)).not.toContain(idle.id);
    });

    it('NEGATIVE: erasing the ATTACKER leaves every one of the victim\'s rows untouched', async () => {
      // Erasure is the one authenticated path that deletes referral rows in
      // bulk, so a scoping defect there destroys a stranger's data rather than
      // merely exposing it.
      const { victim, attacker, referralId } = await twoWorlds();

      const before = await dataSource.query(
        'SELECT id, status FROM referral.referrals WHERE id = $1',
        [referralId],
      );

      await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, attacker.id, tombstoneFor(attacker.id, new Date())),
      );

      expect(await dataSource.query('SELECT id, status FROM referral.referrals WHERE id = $1', [referralId])).toEqual(
        before,
      );
      expect(await counters(victim.id)).toHaveLength(1);
      expect(await ledgerRows(referralId)).not.toHaveLength(0);
      // The victim's own code survives; the attacker's is gone.
      expect(
        await dataSource.query('SELECT 1 FROM referral.referral_codes WHERE owner_user_id = $1', [victim.id]),
      ).toHaveLength(1);
      expect(
        await dataSource.query('SELECT 1 FROM referral.referral_codes WHERE owner_user_id = $1', [attacker.id]),
      ).toHaveLength(0);
    });
  });

  describe('A4 — a repeated claim by the same authenticated caller is replay-safe', () => {
    it('POSITIVE: the first claim attributes, and the response is the caller\'s own facts', async () => {
      const referrer = await customer();
      const referee = await customer();

      const first = await claim(referee, await codeOf(referrer)).expect(200);
      // The caller's OWN two facts, and structurally nothing about the
      // referrer -- not an id, not a name, not a code (ADR-036 §9).
      expect(Object.keys(first.body.data).sort()).toEqual(['attributedAt', 'expiresAt']);
      expect(JSON.stringify(first.body)).not.toContain(referrer.id);
    });

    it('NEGATIVE: five sequential replays leave ONE row and do not move the referrer', async () => {
      const referrer = await customer();
      const other = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      const otherCode = await codeOf(other);

      await claim(referee, code).expect(200);
      const [original] = await referralRows();

      // The same code, then a DIFFERENT valid code -- because an attacker
      // replaying their own claim is trying to re-point it, not to re-run it.
      for (const attempt of [code, code, otherCode, otherCode]) {
        await claim(referee, attempt).expect(409);
      }

      const rows = await referralRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(original);
    });

    it('NEGATIVE: every replay still COSTS a throttle attempt, so replaying is not free', async () => {
      // ADR-036 §6(a): the slot is reserved before eligibility is evaluated,
      // because `V32-DEC-034` prices the throttle as a GUESS RATE and a counter
      // that only counted successes would bound nothing.
      const referrer = await customer();
      const referee = await customer();
      await claim(referee, await codeOf(referrer)).expect(200);

      for (let i = 0; i < REFERRAL_CLAIM_ATTEMPTS_PER_HOUR - 1; i += 1) {
        await claim(referee, 'ZZZZZZZZZZ').expect(409);
      }
      // The successful claim consumed one, so the eleventh request overall is
      // the one that trips -- not the eleventh refusal.
      await claim(referee, 'ZZZZZZZZZZ').expect(429);

      const [attempts] = await dataSource.query(
        'SELECT sum(attempt_count)::int AS n FROM referral.claim_attempts WHERE claimant_user_id = $1',
        [referee.id],
      );
      expect(attempts.n).toBe(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR);
    });
  });

  describe('A5 — simultaneous claims cannot create two attributions', () => {
    it('NEGATIVE: eight concurrent HTTP claims by one referee create exactly one row', async () => {
      const referrers = await Promise.all(Array.from({ length: 8 }, () => customer()));
      const codes = await Promise.all(referrers.map(codeOf));
      const referee = await customer();

      const responses = await Promise.all(codes.map((code) => claim(referee, code)));

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(7);

      const rows = await referralRows();
      expect(rows).toHaveLength(1);
      // The winner is one of the eight, and the losers wrote nothing.
      expect(referrers.map((r) => r.id)).toContain(rows[0].referrer_user_id);
    });

    it('POSITIVE: two DIFFERENT referees claiming ONE code concurrently both succeed', async () => {
      // The mirror image, and the case that proves the unique index is on the
      // REFEREE rather than on the code. A constraint accidentally placed on
      // `referral_code_id` would pass every "one attribution per referee" test
      // above while silently making a referral code single-use -- which is the
      // opposite of what a referral programme is.
      const referrer = await customer();
      const code = await codeOf(referrer);
      const [a, b] = await Promise.all([customer(), customer()]);

      const responses = await Promise.all([claim(a, code), claim(b, code)]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);

      const rows = await referralRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.referrer_user_id === referrer.id)).toBe(true);
      expect(new Set(rows.map((row) => row.referee_user_id)).size).toBe(2);
    });
  });

  describe('A6 — the ACCEPTED erase-and-re-register gap', () => {
    /**
     * **This is a known, decided, bounded gap — not a defect and not an
     * omission.** Issue #13 requires it to be a test with a stated expectation
     * so that a future reader can see it was decided rather than missed.
     *
     * `V32-DEC-019` records it: erasure rewrites `identity.users.phone` to a
     * tombstone alias, so the number becomes registrable again once the
     * approved grace window has closed. The returning person is a genuinely new
     * `user_id` with a genuinely new `created_at`, and **nothing detects that
     * they are the same human** — because detecting it would require exactly
     * the device, IP, browser or fingerprint signal `V32-DEC-019` refuses
     * outright (§A7).
     *
     * The **monthly referrer cap is the bounded-exposure control** (ADR-036's
     * closing section, ADR-038 §12), and the second case below is what makes
     * "bounded" a measured fact rather than a claim.
     */
    it('records the gap: an erased subject can re-register the SAME NUMBER and claim again', async () => {
      const referrer = await customer();
      const code = await codeOf(referrer);
      const phone = '+989179900001';

      const first = await customer(phone);
      await claim(first, code).expect(200);
      expect((await referralRows())[0].referee_user_id).toBe(first.id);

      await eraseSubjectThroughThePlatform(first);

      // The number is genuinely free again: identity rewrote it to a tombstone
      // alias, which is the platform's ratified erasure behaviour and the
      // mechanism the gap rests on.
      const [stillHeld] = await dataSource.query('SELECT phone FROM identity.users WHERE id = $1', [first.id]);
      expect(stillHeld.phone).not.toBe(phone);

      // The retained relationship row survives with the referee side tombstoned
      // -- it explains a loyalty entry the REFERRER may still hold.
      const retained = await referralRows();
      expect(retained).toHaveLength(1);
      expect(retained[0].referee_user_id).toBe(first.id);

      // The same human returns. A new row, a new id, a new `created_at`, and
      // -- STATED EXPECTATION -- the claim SUCCEEDS. `uq_referrals_referee` is
      // on the user id, and the returning person is a different user id.
      const second = await customer(phone);
      expect(second.id).not.toBe(first.id);
      await claim(second, code).expect(200);

      const rows = await referralRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.referee_user_id).sort()).toEqual([first.id, second.id].sort());
      expect(rows.every((row) => row.referrer_user_id === referrer.id)).toBe(true);
    });

    it('is BOUNDED by the monthly cap: cycling cannot mint an eleventh qualified referral', async () => {
      // The control that makes the gap acceptable, measured rather than
      // asserted. A referrer who erases and re-registers invitees all month
      // still qualifies at most `REFERRAL_MONTHLY_CAP` of them, because the
      // counter is keyed on the REFERRER and is untouched by anything the
      // referee's account does.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(0, 0);

      const outcomes: Array<string | null | undefined> = [];
      for (let i = 0; i < REFERRAL_MONTHLY_CAP + 2; i += 1) {
        const referee = await customer();
        await pendingReferral(referrer, referee);
        const result = await qualifyFor(referee);
        outcomes.push(result.referrerOutcome);

        // Erasing the referee afterwards is exactly what the gap permits, and
        // it must not give the referrer their slot back.
        await dataSource.transaction((manager) =>
          referralContract().eraseSubjectData(manager, referee.id, tombstoneFor(referee.id, new Date())),
        );
      }

      expect(outcomes.filter((o) => o === 'awarded' || o === 'disabled_zero')).toHaveLength(REFERRAL_MONTHLY_CAP);
      expect(outcomes.filter((o) => o === 'capped')).toHaveLength(2);
      expect(await counters(referrer.id)).toEqual([{ period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP }]);
    });
  });

  describe('A7 — no device, IP, browser or fingerprint signal exists to be added by accident', () => {
    it('NEGATIVE: no referral column could hold one', async () => {
      // `V32-DEC-019` refuses these outright, and this is the assertion that
      // keeps the refusal true as the schema grows: a column added later with
      // any of these names fails here rather than being noticed in review.
      const columns = (await dataSource.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'referral'`,
      )) as Array<{ table_name: string; column_name: string }>;

      expect(columns.length).toBeGreaterThan(0); // the catalogue query itself works
      // Anchored on whole `snake_case` SEGMENTS rather than on substrings.
      // An unanchored /ip/ matches `recipient_user_id`, which would fail this
      // case against two columns that are exactly what ADR-027's coverage
      // heuristic asks for -- a false positive that would train the next author
      // to loosen the assertion rather than to look at it.
      const forbidden = /(^|_)(ip|ips|ip_address|user_agent|agent|device|fingerprint|browser|geo|latitude|longitude|session_id)(_|$)/i;
      expect(columns.filter((c) => forbidden.test(c.column_name))).toEqual([]);
    });

    it('NEGATIVE: a claim carrying fingerprinting headers is attributed IDENTICALLY', async () => {
      // Behavioural rather than structural: if any signal were being read, two
      // claims differing only in these headers could not produce identical
      // stored rows and identical bodies.
      const referrer = await customer();
      const code = await codeOf(referrer);

      const plain = await claim(await customer(), code).expect(200);
      const fingerprinted = await http()
        .post('/api/v1/me/referral/claim')
        .set('Authorization', `Bearer ${(await customer()).accessToken}`)
        .set('User-Agent', 'AttackerBrowser/1.0')
        .set('X-Forwarded-For', '203.0.113.7')
        .set('X-Device-Id', 'device-abcdef')
        .send({ code })
        .expect(200);

      expect(Object.keys(fingerprinted.body.data).sort()).toEqual(Object.keys(plain.body.data).sort());

      const stored = (await dataSource.query(
        `SELECT * FROM referral.referrals ORDER BY attributed_at, id`,
      )) as Array<Record<string, unknown>>;
      expect(stored).toHaveLength(2);
      // Every column except the two ids and the instants is identical, and no
      // column anywhere holds a header value.
      expect(JSON.stringify(stored)).not.toMatch(/AttackerBrowser|203\.0\.113\.7|device-abcdef/);
    });
  });

  // ==========================================================================
  // B. QUALIFICATION AND REWARD
  // ==========================================================================

  describe('B1 — both configured reward values are exactly zero', () => {
    it('NEGATIVE: neither default has drifted off zero, at BOTH sources of truth', async () => {
      // `V32-DEC-016` sets both to 0 and a non-zero figure is a NEW OWNER
      // DECISION -- not a configuration convenience, not a roadmap example, and
      // specifically not V2's 50. The suites that prove the paying path inject
      // values through the config token, so nothing in the test tree needs the
      // defaults to move; if one ever does, this is the case that says so.
      //
      // Both sources are asserted because they are genuinely two objects:
      // `REFERRAL_REWARD_DEFAULTS` is what the domain binds when nothing
      // composes it, and `LOYALTY_POLICY_DEFAULTS` is what the composition root
      // supplies. A drift in either would ship a reward the owner never approved.
      expect(REFERRAL_REWARD_DEFAULTS).toEqual({ referrerPoints: 0, refereePoints: 0 });
      expect(LOYALTY_POLICY_DEFAULTS.pointsReferralReferrer).toBe(0);
      expect(LOYALTY_POLICY_DEFAULTS.pointsReferralReferee).toBe(0);
    });

    it('NEGATIVE: the RUNNING application resolves both to zero', async () => {
      // The constants above could be correct while the composition root bound
      // something else -- which is the only version of this that a deployment
      // would actually experience.
      const live = app.get<ReferralRewardConfig>(REFERRAL_REWARD_CONFIG);
      expect(live.referrerPoints).toBe(0);
      expect(live.refereePoints).toBe(0);
    });

    it('POSITIVE non-vacuity: the injection helper CAN move them, so zero above is measured', async () => {
      // Without this, the two cases above would also pass if the values were
      // frozen constants nothing could ever change -- and the whole "a later
      // approved figure is still awardable" guarantee would be untested.
      withRewards(7, 11);
      const live = app.get<ReferralRewardConfig>(REFERRAL_REWARD_CONFIG);
      expect(live.referrerPoints).toBe(7);
      expect(live.refereePoints).toBe(11);
      restoreRewards();
      expect(app.get<ReferralRewardConfig>(REFERRAL_REWARD_CONFIG).referrerPoints).toBe(0);
    });
  });

  describe('B2 — the two slots a zero-value qualification does and does not consume', () => {
    /**
     * **These are two different slots and conflating them is the trap.**
     *
     * *  The **ledger idempotency slot** —
     *    `uq_points_entries_reference_once (reference_type, reference_id,
     *    reason)` — is **NOT** consumed at zero. `V32-DEC-016` and ADR-037 §8
     *    make that load-bearing: a zero row would occupy the slot permanently
     *    and the figure the business eventually approves would be silently
     *    deduplicated away, surfacing months later as *"we turned the reward on
     *    and nobody got anything"*.
     *
     * *  The **monthly cap slot** — `referral.referrer_counters` — **IS**
     *    consumed, because the counter increments inside the qualification CAS's
     *    success branch (ADR-037 §5, §7) and counts **qualifications the
     *    platform processed**, not rewards that were paid. `V32-DEC-036` states
     *    the same principle from the reversal side: a cap that a zero value or a
     *    refund could refund would bound nothing.
     *
     * Both are named here so the distinction is recorded rather than inferred.
     */
    it('NEGATIVE: a zero-value qualification writes no ledger row and consumes NO idempotency slot', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      withRewards(0, 0);

      const result = await qualifyFor(referee);
      expect(result.qualified).toBe(true);
      expect(result.referrerOutcome).toBe('disabled_zero');
      expect(result.refereeOutcome).toBe('disabled_zero');
      expect(await ledgerRows(referralId)).toEqual([]);
    });

    it('POSITIVE: the slot is still FREE, so a later approved figure is awardable against the same referral', async () => {
      // The half that makes the absence above load-bearing rather than merely
      // tidy. This is the business turning the reward on afterwards.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      withRewards(0, 0);
      await qualifyFor(referee);
      expect(await ledgerRows(referralId)).toEqual([]);

      const awarded = await dataSource.transaction((manager) =>
        ledger.award(
          {
            userId: referrer.id,
            reason: 'referral_referrer_reward',
            referenceType: 'referral',
            referenceId: referralId,
            overridePoints: 250,
          },
          manager,
        ),
      );
      expect(awarded).toBeTruthy();

      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: referrer.id, base_points: 250 });
    });

    it('POSITIVE: a zero-value qualification DOES consume a monthly cap slot', async () => {
      // The counterpart, and the one a reader is most likely to get backwards.
      const referrer = await customer();
      const referee = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(0, 0);
      await pendingReferral(referrer, referee);

      await qualifyFor(referee);

      expect(await counters(referrer.id)).toEqual([{ period: '1405-06', qualified_count: 1 }]);
    });

    it('NEGATIVE: ten zero-value qualifications CAP the eleventh, exactly as paid ones do', async () => {
      // Stated as a behaviour rather than as a counter reading, because the
      // consequence -- not the column -- is what an operator would notice.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(0, 0);

      const outcomes: Array<string | null | undefined> = [];
      for (let i = 0; i < REFERRAL_MONTHLY_CAP + 1; i += 1) {
        const referee = await customer();
        await pendingReferral(referrer, referee);
        outcomes.push((await qualifyFor(referee)).referrerOutcome);
      }

      expect(outcomes.slice(0, REFERRAL_MONTHLY_CAP)).toEqual(Array(REFERRAL_MONTHLY_CAP).fill('disabled_zero'));
      expect(outcomes[REFERRAL_MONTHLY_CAP]).toBe('capped');
    });

    it('POSITIVE: at the cap, the REFEREE side is still paid — the owner correction', async () => {
      // `V32-DEC-019`'s first owner correction, and the single most important
      // behaviour in the whole reward path: an invited customer must never lose
      // their own approved reward because of the INVITER's activity.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(50, 30);

      for (let i = 0; i < REFERRAL_MONTHLY_CAP; i += 1) {
        const filler = await customer();
        await pendingReferral(referrer, filler);
        await qualifyFor(filler);
      }

      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const result = await qualifyFor(referee);

      expect(result.referrerOutcome).toBe('capped');
      expect(result.refereeOutcome).toBe('awarded');

      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: referee.id, base_points: 30, reason: 'referral_referee_reward' });
    });
  });

  // ==========================================================================
  // C. COUNTER AND CAP
  // ==========================================================================

  describe('C1 — the Solar Hijri period boundary, at real instants against the real counter', () => {
    /**
     * `V32-DEC-035` ratifies the **Solar Hijri (Jalali)** month beginning at
     * 00:00 `Asia/Tehran`. Iran abolished DST in 2022, so Tehran is UTC+03:30
     * and 1 Mehr 1405 begins at **2026-09-22T20:30:00.000Z**.
     *
     * The pure `tehranCalendarMonth` function is already tested at exact
     * instants in the fast suite. What was NOT tested is the thing an operator
     * actually experiences: which **counter row** a qualification lands in when
     * it happens either side of that instant, in the real table, under the real
     * conditional increment.
     */
    const LAST_MS_OF_SHAHRIVAR = new Date('2026-09-22T20:29:59.999Z');
    const FIRST_MS_OF_MEHR = new Date('2026-09-22T20:30:00.000Z');

    it('POSITIVE: the boundary instants are the ones this case claims they are', async () => {
      // Stated in the suite rather than assumed, so a reader can check the
      // arithmetic without leaving the file -- and so a future timezone-database
      // change that moved the offset would fail HERE, naming the cause, rather
      // than as a confusing off-by-one in the two cases below.
      expect(tehranCalendarMonth(LAST_MS_OF_SHAHRIVAR)).toBe('1405-06');
      expect(tehranCalendarMonth(FIRST_MS_OF_MEHR)).toBe('1405-07');
    });

    it('NEGATIVE: one millisecond BEFORE the boundary still spends the old month\'s allowance', async () => {
      const referrer = await customer();
      withRewards(0, 0);
      ctx.referralClock.freeze(LAST_MS_OF_SHAHRIVAR);

      const referee = await customer();
      await pendingReferral(referrer, referee);
      await qualifyFor(referee);

      expect(await counters(referrer.id)).toEqual([{ period: '1405-06', qualified_count: 1 }]);
    });

    it('POSITIVE: one millisecond LATER opens a fresh allowance, in a new row', async () => {
      const referrer = await customer();
      withRewards(0, 0);

      ctx.referralClock.freeze(LAST_MS_OF_SHAHRIVAR);
      const before = await customer();
      await pendingReferral(referrer, before);
      await qualifyFor(before);

      ctx.referralClock.freeze(FIRST_MS_OF_MEHR);
      const after = await customer();
      await pendingReferral(referrer, after);
      await qualifyFor(after);

      // TWO rows, not one incremented row: the allowance reset rather than
      // continuing, and the old period's count is left exactly where it was.
      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: 1 },
        { period: '1405-07', qualified_count: 1 },
      ]);
    });

    it('NEGATIVE: a referrer CAPPED one millisecond before the boundary qualifies again one millisecond after', async () => {
      // The consequence an operator would actually see, and the case a
      // Gregorian implementation fails: both instants are Gregorian September,
      // so a Gregorian bucket would keep one row and refuse the eleventh.
      const referrer = await customer();
      withRewards(0, 0);
      ctx.referralClock.freeze(LAST_MS_OF_SHAHRIVAR);

      for (let i = 0; i < REFERRAL_MONTHLY_CAP; i += 1) {
        const filler = await customer();
        await pendingReferral(referrer, filler);
        await qualifyFor(filler);
      }
      const eleventh = await customer();
      await pendingReferral(referrer, eleventh);
      expect((await qualifyFor(eleventh)).referrerOutcome).toBe('capped');

      ctx.referralClock.freeze(FIRST_MS_OF_MEHR);
      const nextMonth = await customer();
      await pendingReferral(referrer, nextMonth);
      expect((await qualifyFor(nextMonth)).referrerOutcome).toBe('disabled_zero');

      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP },
        { period: '1405-07', qualified_count: 1 },
      ]);
    });
  });

  // ==========================================================================
  // D. REFUND AND REVERSAL — the cross-story abuse chain
  // ==========================================================================

  describe('D1 — qualification/refund cycling cannot mint value or reclaim a cap slot', () => {
    /**
     * The chain `V32-DEC-036` exists to close, run end-to-end across all four
     * stories rather than inside any one of them.
     *
     * A referrer colluding with invitees who book and then refund would, if a
     * reversal returned the cap slot, be able to reuse one slot indefinitely —
     * and the monthly cap, which `V32-DEC-019` names as the bounded-exposure
     * control for the §A6 gap, would bound nothing at all.
     */
    it('NEGATIVE: ten qualify-then-refund cycles leave the referrer capped, with nothing left to spend', async () => {
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(50, 30);

      for (let i = 0; i < REFERRAL_MONTHLY_CAP; i += 1) {
        const referee = await customer();
        await pendingReferral(referrer, referee);
        const bookingId = uuidv7();
        const orderId = await paidOrder(bookingId, referee.id);
        expect((await qualifyFor(referee, bookingId)).qualified).toBe(true);

        // The refund the attacker is relying on.
        await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());
        await reverseFor(orderId);
      }

      // Every slot is spent and STAYS spent -- `V32-DEC-036`.
      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP },
      ]);

      const eleventh = await customer();
      await pendingReferral(referrer, eleventh);
      expect((await qualifyFor(eleventh)).referrerOutcome).toBe('capped');

      // And the cycling minted nothing: every awarded point was clawed back.
      const [balance] = await dataSource.query(
        `SELECT coalesce(sum(points), 0)::int AS n FROM loyalty.points_entries WHERE user_id = $1`,
        [referrer.id],
      );
      expect(balance.n).toBe(0);
    });

    it('NEGATIVE: the reversal cannot produce a SECOND negative entry, however many times it is replayed', async () => {
      // Concurrent AND sequential redelivery against one order, because the two
      // are guarded by different mechanisms: the CAS handles the sequential
      // case, and the ledger's reversal-reason idempotency slot is the second,
      // independent guard behind it.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);
      withRewards(50, 30);
      await qualifyFor(referee, bookingId);
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      await Promise.all([reverseFor(orderId), reverseFor(orderId), reverseFor(orderId)]);
      await reverseFor(orderId);
      await reverseFor(orderId);

      const negatives = (await ledgerRows(referralId)).filter((row) => row.points < 0);
      expect(negatives).toHaveLength(2); // one per side, exactly
      expect(negatives.map((row) => row.reason).sort()).toEqual([
        'referral_referee_reversal',
        'referral_referrer_reversal',
      ]);
      expect(await ledger.balance(referrer.id)).toBe(0);
      expect(await ledger.balance(referee.id)).toBe(0);
    });

    it('POSITIVE: the snapshotted reason and amount survive the configuration being changed afterwards', async () => {
      // `V32-DEC-017` and ADR-038 §5: a later configuration change must not
      // alter what a past reward is worth on the way back out. The reversal
      // reads the persisted ledger row, never current configuration.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      withRewards(50, 30);
      await qualifyFor(referee, bookingId);

      // The business changes the economics between the award and the refund --
      // including switching one side off entirely.
      withRewards(0, 9_999);

      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());
      await reverseFor(orderId);

      const rows = await ledgerRows(referralId);
      const referrerNegative = rows.find((row) => row.reason === 'referral_referrer_reversal');
      const refereeNegative = rows.find((row) => row.reason === 'referral_referee_reversal');

      // The ORIGINAL figures, not the current ones.
      expect(referrerNegative).toMatchObject({ user_id: referrer.id, points: -50 });
      expect(refereeNegative).toMatchObject({ user_id: referee.id, points: -30 });
    });
  });

  // ==========================================================================
  // E. SECURITY AND PRIVACY
  // ==========================================================================

  describe('E1 — the code reaches no metric label', () => {
    /**
     * `V32-DEC-033` forbids a referral code in event payloads, notification
     * payloads, analytics dimensions, **metric labels**, and log lines. The
     * story suites prove the first four and the logs; the metric exposition is
     * the one sink nothing had looked at.
     *
     * The mechanism is that the domain registers no metric at all (ADR-035 §7,
     * ADR-036 §10), so there is no label to attach one to — enforced by there
     * being no path rather than by redaction.
     */
    const forbiddenIn = (exposition: string, secrets: string[]) =>
      secrets.filter((secret) => exposition.includes(secret));

    it('NEGATIVE: the whole metrics exposition carries no code, phone or referral series', async () => {
      const registry = app.get(MetricsRegistry);
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      // Exercise the whole lifecycle so anything that WOULD be instrumented has
      // been. An exposition scraped before the code ever existed proves nothing.
      await claim(referee, code).expect(200);
      await claim(await customer(), 'ZZZZZZZZZZ').expect(409);
      withRewards(0, 0);
      await qualifyFor(referee);

      const exposition = registry.render();
      expect(exposition.length).toBeGreaterThan(0); // the renderer produced something
      expect(forbiddenIn(exposition, [code, referrer.phone, referee.phone, referrer.id])).toEqual([]);
      // And no referral-named series exists to grow a label later.
      expect(exposition).not.toMatch(/^[a-z_]*referral[a-z_]*/m);
    });

    it('NEGATIVE non-vacuity: the SAME detector finds a code planted in a metric label', async () => {
      // The plant. Without it, the case above would pass if `render()` returned
      // an empty string, if the registry were the wrong object, or if
      // `forbiddenIn` compared the wrong things.
      const code = await codeOf(await customer());

      const planted = new MetricsRegistry();
      planted.registerCounter('beauclick_planted_total', 'A deliberately leaky metric.', ['code']);
      planted.increment('beauclick_planted_total', { code });

      const exposition = planted.render();
      expect(forbiddenIn(exposition, [code])).toEqual([code]);
    });
  });

  describe('E2 — the registered event schemas admit no field a code could travel through', () => {
    /**
     * ADR-037 §10 requires the payload audit to **walk the registered schema**
     * rather than read the source, and to be paired with a negative control —
     * because a schema audit that cannot fail proves nothing.
     *
     * `referral-qualification.spec.ts` already does this for `ReferralQualified`
     * against a hand-written fixture in the fast suite. What is new here is the
     * two things that suite cannot do:
     *
     *  *  it probes **both** approved events, so the domain's whole emission
     *     vocabulary is covered rather than one event of it;
     *  *  it probes each schema against the payload the producer **actually
     *     wrote to the outbox**, so a fixture that had drifted away from what is
     *     emitted could not hide a field.
     *
     * The probe is **behavioural rather than structural**, for the reason that
     * suite's docblock records: reading zod's internals made an earlier version
     * a test of the walker instead of a test of the schema, and it broke on a
     * zod major version. Substituting prose into each field and asking whether
     * the schema still parses asks the question that actually matters — could a
     * referral code, a phone number, or a display name travel in this field.
     */
    const PROSE = 'a referral code A1B2C3D4E5 or a display name or any other prose';

    /** Every field of `schema` that would ACCEPT arbitrary prose. */
    function proseAcceptingFields(schema: z.ZodTypeAny, valid: Record<string, unknown>): string[] {
      return Object.keys(valid).filter((field) => schema.safeParse({ ...valid, [field]: PROSE }).success);
    }

    /** A qualified-then-reversed referral, so BOTH approved events are on the outbox. */
    async function bothEventsEmitted() {
      const referrer = await customer();
      const referee = await customer();
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);
      await pendingReferral(referrer, referee);

      withRewards(50, 30);
      await qualifyFor(referee, bookingId);
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());
      await reverseFor(orderId);

      const rows = (await dataSource.query(
        'SELECT event_type, payload FROM referral.outbox_events ORDER BY id',
      )) as Array<{ event_type: string; payload: Record<string, unknown> }>;
      return { rows, referrer, referee };
    }

    it('POSITIVE: exactly the two approved events are emitted, and nothing else', async () => {
      // `V32-DEC-033` approves `ReferralQualified` v1 and `ReferralReversed` v1
      // and nothing else. Asserted first, because the prose probe below is only
      // as complete as the set of events it is pointed at.
      const { rows } = await bothEventsEmitted();
      expect(rows.map((row) => row.event_type).sort()).toEqual(['ReferralQualified', 'ReferralReversed']);
    });

    it('NEGATIVE: no field of EITHER event accepts prose, probed against the REAL payloads', async () => {
      const { rows } = await bothEventsEmitted();

      for (const row of rows) {
        const contract = ALL_EVENT_CONTRACTS.find((c) => c.name === row.event_type);
        expect(contract).toBeDefined();

        // The real payload must itself be valid, or the probe would be
        // substituting into a sample the schema already rejects and every field
        // would read as clean.
        expect(contract!.schema.safeParse(row.payload).success).toBe(true);

        expect({
          event: row.event_type,
          proseAccepting: proseAcceptingFields(contract!.schema as z.ZodTypeAny, row.payload),
        }).toEqual({ event: row.event_type, proseAccepting: [] });
      }
    });

    it('NEGATIVE: neither emitted payload contains a code, a phone, or any Persian prose', async () => {
      // The schema is one guarantee; what the producer actually wrote is
      // another, and a payload could carry an extra key the schema never
      // mentioned. Planted positive controls: values that genuinely exist in
      // the database for these two people.
      const { rows, referrer, referee } = await bothEventsEmitted();
      const code = await codeOf(referrer);

      for (const row of rows) {
        const serialised = JSON.stringify(row.payload);
        expect(serialised).not.toContain(code);
        expect(serialised).not.toContain(referrer.phone);
        expect(serialised).not.toContain(referee.phone);
        expect(serialised).not.toMatch(/[؀-ۿ]/);
      }
    });

    it('NEGATIVE non-vacuity: the SAME probe catches a PLANTED prose field', async () => {
      // The planted-field negative control ADR-037 §10 requires by name.
      // Without it, an empty result could mean "the schema is clean" or "the
      // probe detects nothing" — and those two look identical.
      const planted = z.object({
        referralId: z.string().uuid(),
        // Exactly what a well-meaning future author would add.
        referrerDisplayName: z.string(),
      });
      const sample = { referralId: uuidv7(), referrerDisplayName: 'Someone' };

      expect(proseAcceptingFields(planted, sample)).toEqual(['referrerDisplayName']);
    });
  });

  describe('E3 — the code reaches no log line, and the detector is proved first', () => {
    it('NEGATIVE non-vacuity: the capture mechanism DOES see a planted value', async () => {
      // Asserted BEFORE the real absence check is trusted. `referral.pg-spec`'s
      // docblock records the version of this that captured only the process
      // streams and passed while capturing nothing at all.
      const canary = 'CANARY7X9Q';
      const { args, output } = await recordLogging(async () => {
        new Logger('AdversarialProbe').log(`planted ${canary}`);
        process.stdout.write(`planted ${canary}\n`);
      });

      expect(args).toContain(canary);
      expect(output).toContain(canary);
    });

    it('NEGATIVE: a full claim/refuse/qualify lifecycle logs no code and no phone', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);

      const { args, output } = await recordLogging(async () => {
        await claim(referee, code).expect(200);
        await claim(await customer(), code.toLowerCase()).expect(409); // the realistic mistyping
        await claim(await customer(), 'ZZZZZZZZZZ').expect(409);
        withRewards(0, 0);
        await qualifyFor(referee);
      });

      for (const secret of [code, code.toLowerCase(), referrer.phone, referee.phone]) {
        expect(args).not.toContain(secret);
        expect(output).not.toContain(secret);
      }
    });
  });

  describe('E4 — subject-data coverage stays complete for the whole referral domain', () => {
    it('POSITIVE: every referral table in the REAL catalogue is claimed, in both directions', async () => {
      // Both directions, and the count is deliberately not asserted: a table
      // added without a claim, and a claim left behind after a table is
      // dropped, are both failures and neither is a number.
      const catalogue = (await dataSource.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'referral' AND table_type = 'BASE TABLE'`,
      )) as Array<{ table_name: string }>;
      const real = catalogue.map((row) => `referral.${row.table_name}`).sort();
      expect(real.length).toBeGreaterThan(0);

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS, { strict: false });
      const referralModule = contracts.find((c) => c.moduleKey === 'referral');
      expect(referralModule).toBeDefined();

      const claimed = referralModule!.tables.map((t) => t.table).sort();
      expect(claimed).toEqual(real);
    });

    it('NEGATIVE: the referrer export carries their own code and NO referee identity', async () => {
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      await claim(referee, code).expect(200);

      const serialised = JSON.stringify(await exportFor(referrer.id));
      expect(serialised).toContain(code); // their own bearer credential, to them
      expect(serialised).not.toContain(referee.id);
      expect(serialised).not.toContain(referee.phone);
    });

    it('NEGATIVE: the referee export NEVER carries the referrer\'s code', async () => {
      // Structural rather than filtered: ADR-036 §2 keeps the code STRING off
      // `referral.referrals` entirely, so there is nothing for a careless join
      // to reach.
      const referrer = await customer();
      const referee = await customer();
      const code = await codeOf(referrer);
      await claim(referee, code).expect(200);

      const serialised = JSON.stringify(await exportFor(referee.id));
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(referrer.id);
      expect(serialised).not.toContain(referrer.phone);

      // Non-vacuous: the referee's OWN fact is there.
      const received = (await exportFor(referee.id)).find((section) => section.key === 'referral_received');
      expect(received?.rows).toHaveLength(1);
    });
  });
});
