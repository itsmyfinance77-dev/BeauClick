import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';
import { BookingCompleted, ReferralQualified } from '@beauclick/event-contracts';
import { LOYALTY_REASONS, LoyaltyLedgerService } from '@beauclick/loyalty';
import {
  REFERRAL_MONTHLY_CAP,
  REFERRAL_REWARD_CONFIG,
  ReferralQualificationService,
  ReferralRewardConfig,
} from '@beauclick/referral';

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
 * Referral qualification and the two-sided reward, against real PostgreSQL
 * (V3.2-C Story #12, ADR-037).
 *
 * ## Why this cannot be proved anywhere else
 *
 * Every guarantee this story makes is a **database** or **concurrency**
 * guarantee, and pg-mem honours none of them: it has no
 * `ON CONFLICT … DO UPDATE … WHERE`, no triggers, no partial unique index
 * semantics under concurrent transactions, and it does not honour `ROLLBACK`.
 * A compare-and-swap, a conditional cap, a ledger idempotency slot, and a
 * transaction that must roll back **whole** are exactly the four things a fake
 * would agree with itself about.
 *
 * ## The reward values are ZERO, so most of this suite proves absence
 *
 * `V32-DEC-016` sets both to 0, and the suite's job is largely to prove that
 * zero is *honestly disabled* rather than broken: qualification recorded,
 * grants recorded, **no ledger row and no idempotency slot consumed**. The
 * paying path is proved by **injecting positive values through the config
 * token** — never by editing a default, which would be inventing economics no
 * owner approved.
 */
describePg('referral qualification — CAS, two sides, cap, ledger (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let qualification: ReferralQualificationService;
  let ledger: LoyaltyLedgerService;
  let rewards: { referrerPoints: number; refereePoints: number };

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    qualification = app.get(ReferralQualificationService);
    ledger = app.get(LoyaltyLedgerService);
    // The live config object. Mutated per-test to prove the paying path, and
    // restored in `beforeEach` -- see `withRewards`.
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

  /**
   * Temporarily overrides the two configured reward values.
   *
   * `REFERRAL_REWARD_CONFIG` is bound at the composition root to an object with
   * GETTERS onto `LoyaltyConfig.policy`, so it cannot simply be assigned. This
   * redefines the two properties for the duration of a test and
   * `restoreRewards` puts the getters back.
   *
   * **This is how the paying path is proved, and it matters that it is done
   * this way.** `V32-DEC-016` set both production values to 0; a test that
   * edited the default to make ledger rows appear would be inventing economics
   * no owner approved, and would leave the repository one careless merge from
   * shipping them.
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
  async function customer(): Promise<SeededUser> {
    seq += 1;
    return seedUser(app, dataSource, `+9891590${String(seq).padStart(5, '0')}`);
  }

  /** A pending attribution, written directly — Story #27's claim route is not under test here. */
  async function pendingReferral(
    referrer: SeededUser,
    referee: SeededUser,
    options: { attributedAt?: Date; expiresAt?: Date } = {},
  ): Promise<string> {
    const id = uuidv7();
    const attributedAt = options.attributedAt ?? new Date(Date.now() - DAY_MS);
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 89 * DAY_MS);
    await dataSource.query(
      `INSERT INTO referral.referrals
         (id, referrer_user_id, referee_user_id, referral_code_id, attributed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, referrer.id, referee.id, uuidv7(), attributedAt, expiresAt],
    );
    return id;
  }

  /** Runs the qualification exactly as the handler does: one transaction, caller's manager. */
  async function qualifyFor(referee: SeededUser, bookingId = uuidv7()) {
    return dataSource.transaction((manager) =>
      qualification.qualify(manager, { refereeUserId: referee.id, bookingId }),
    );
  }

  async function referralRow(id: string) {
    const [row] = await dataSource.query('SELECT * FROM referral.referrals WHERE id = $1', [id]);
    return row as {
      status: string;
      qualified_at: Date | null;
      qualifying_booking_id: string | null;
    };
  }

  async function grants(referralId: string) {
    return dataSource.query(
      'SELECT side, outcome, points, ledger_reason, recipient_user_id FROM referral.reward_grants WHERE referral_id = $1 ORDER BY side',
      [referralId],
    ) as Promise<
      Array<{ side: string; outcome: string; points: number; ledger_reason: string; recipient_user_id: string }>
    >;
  }

  async function ledgerRows(referralId: string) {
    return dataSource.query(
      `SELECT user_id, points, base_points, reason FROM loyalty.points_entries
        WHERE reference_type = 'referral' AND reference_id = $1 ORDER BY reason`,
      [referralId],
    ) as Promise<Array<{ user_id: string; points: number; base_points: number; reason: string }>>;
  }

  async function outboxEvents() {
    return dataSource.query(
      'SELECT event_type, event_version, payload FROM referral.outbox_events ORDER BY created_at',
    ) as Promise<Array<{ event_type: string; event_version: number; payload: Record<string, unknown> }>>;
  }

  async function counters(referrerUserId: string) {
    return dataSource.query(
      'SELECT period, qualified_count FROM referral.referrer_counters WHERE referrer_user_id = $1 ORDER BY period',
      [referrerUserId],
    ) as Promise<Array<{ period: string; qualified_count: number }>>;
  }

  // ==========================================================================
  // 1. The happy path, and what it actually records
  // ==========================================================================

  describe('a valid pending referral', () => {
    it('qualifies, and records the ACTUAL booking that caused it', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();

      const result = await qualifyFor(referee, bookingId);
      expect(result.qualified).toBe(true);
      expect(result.referralId).toBe(referralId);

      const row = await referralRow(referralId);
      expect(row.status).toBe('qualified');
      expect(row.qualified_at).not.toBeNull();
      // The Story #28 anchor. Not "a" booking -- THE booking from the event.
      expect(row.qualifying_booking_id).toBe(bookingId);
    });

    it('writes BOTH grants, independently, even though both pay nothing', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      await qualifyFor(referee);

      const rows = await grants(referralId);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual([
        {
          side: 'referee',
          outcome: 'disabled_zero',
          points: 0,
          ledger_reason: 'referral_referee_reward',
          recipient_user_id: referee.id,
        },
        {
          side: 'referrer',
          outcome: 'disabled_zero',
          points: 0,
          ledger_reason: 'referral_referrer_reward',
          recipient_user_id: referrer.id,
        },
      ]);
    });

    it('increments the referrer cap counter in the JALALI month', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);

      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      await qualifyFor(referee);

      expect(await counters(referrer.id)).toEqual([{ period: '1405-06', qualified_count: 1 }]);
    });

    it('emits exactly one ReferralQualified v1, with a truthful payload', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();

      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      await qualifyFor(referee, bookingId);

      const events = await outboxEvents();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('ReferralQualified');
      expect(events[0].event_version).toBe(1);
      expect(events[0].payload).toEqual({
        referralId,
        referrerUserId: referrer.id,
        refereeUserId: referee.id,
        qualifyingBookingId: bookingId,
        qualifiedAt: '2026-09-15T10:00:00.000Z',
        referrerOutcome: 'disabled_zero',
        referrerPoints: 0,
        refereeOutcome: 'disabled_zero',
        refereePoints: 0,
      });
    });
  });

  // ==========================================================================
  // 2. Only BookingCompleted qualifies
  // ==========================================================================

  describe('the qualifying trigger', () => {
    it('registers a handler for BookingCompleted and for NOTHING else that could qualify', async () => {
      // `V32-DEC-018`: the referee's first `BookingCompleted`, and nothing else.
      // Asserted structurally -- there is exactly one caller of `qualify`, and
      // it is bound to this event type.
      const { BookingCompletedReferralHandler } = await import('../src/events/referral-qualification.handlers');
      const handler = app.get(BookingCompletedReferralHandler);

      expect(handler.eventType).toBe(BookingCompleted.name);
      expect(handler.eventVersion).toBe(BookingCompleted.version);
      expect(handler.eventType).not.toBe('OrderPaid');
      expect(handler.eventType).not.toBe('BookingConfirmed');
    });

    it('nothing in the referral module reads OrderPaid, BookingConfirmed, or the booking table', async () => {
      // The refusals are structural rather than a branch. `V32-DEC-018` calls
      // OrderPaid the sharpest refusal: money moves BEFORE delivery and can be
      // refunded within minutes, so qualifying on payment would maximise the
      // window in which a reward exists for a service that never happened.
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const service = readFileSync(
        join(__dirname, '..', '..', '..', 'services', 'referral', 'src', 'referral-qualification.service.ts'),
        'utf8',
      );
      const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      expect(code).not.toMatch(/OrderPaid|BookingConfirmed|BookingCancelled|OrderRefunded/);
      expect(code).not.toMatch(/booking\.bookings|FROM booking\./);
      // Non-vacuity: the stripper must leave the code it is searching.
      expect(code).toMatch(/UPDATE referral\.referrals/);
    });

    it('does not qualify a referee who has no pending referral', async () => {
      const stranger = await customer();

      const result = await qualifyFor(stranger);

      expect(result.qualified).toBe(false);
      expect(await outboxEvents()).toHaveLength(0);
      expect(await dataSource.query('SELECT 1 FROM referral.reward_grants')).toHaveLength(0);
      expect(await dataSource.query('SELECT 1 FROM referral.referrer_counters')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 3. The CAS: expiry, replay, and the affected-row check
  // ==========================================================================

  describe('the compare-and-swap', () => {
    it('refuses an EXPIRED referral, writing nothing', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee, {
        attributedAt: new Date(Date.now() - 200 * DAY_MS),
        expiresAt: new Date(Date.now() - DAY_MS),
      });

      const result = await qualifyFor(referee);

      expect(result.qualified).toBe(false);
      expect((await referralRow(referralId)).status).toBe('pending');
      expect(await grants(referralId)).toHaveLength(0);
      expect(await outboxEvents()).toHaveLength(0);
      expect(await counters(referrer.id)).toHaveLength(0);
    });

    it('refuses at the EXACT expiry instant — the comparison is strict', async () => {
      const referrer = await customer();
      const referee = await customer();
      const frozen = new Date('2026-09-15T10:00:00.000Z');
      const referralId = await pendingReferral(referrer, referee, {
        attributedAt: new Date(frozen.getTime() - 90 * DAY_MS),
        // expires_at EXACTLY equal to the qualification instant.
        expiresAt: frozen,
      });

      ctx.referralClock.freeze(frozen);
      expect((await qualifyFor(referee)).qualified).toBe(false);
      expect((await referralRow(referralId)).status).toBe('pending');
    });

    it('qualifies one millisecond before expiry', async () => {
      // The other side of the boundary. Without this, a CAS that refused
      // EVERYTHING would pass the case above.
      const referrer = await customer();
      const referee = await customer();
      const frozen = new Date('2026-09-15T10:00:00.000Z');
      await pendingReferral(referrer, referee, {
        attributedAt: new Date(frozen.getTime() - 90 * DAY_MS),
        expiresAt: new Date(frozen.getTime() + 1),
      });

      ctx.referralClock.freeze(frozen);
      expect((await qualifyFor(referee)).qualified).toBe(true);
    });

    it('DUPLICATE delivery qualifies once and changes nothing the second time', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();

      expect((await qualifyFor(referee, bookingId)).qualified).toBe(true);
      const after = await referralRow(referralId);

      // The redelivery, which the outbox makes the steady state rather than an
      // exception.
      expect((await qualifyFor(referee, bookingId)).qualified).toBe(false);

      expect(await referralRow(referralId)).toEqual(after);
      expect(await grants(referralId)).toHaveLength(2);
      expect(await outboxEvents()).toHaveLength(1);
      expect(await counters(referrer.id)).toEqual([
        { period: expect.any(String), qualified_count: 1 },
      ]);
    });

    it('a LATER booking does not re-qualify, and does not move the recorded booking', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const first = uuidv7();
      const second = uuidv7();

      await qualifyFor(referee, first);
      expect((await qualifyFor(referee, second)).qualified).toBe(false);

      // Qualification is once per REFERRAL, not once per booking -- and the
      // recorded booking stays the one that actually qualified it, which Story
      // #28 depends on.
      expect((await referralRow(referralId)).qualifying_booking_id).toBe(first);
    });

    it('CONCURRENT duplicate delivery qualifies exactly once', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => qualifyFor(referee)),
      );

      const qualified = results.filter(
        (r) => r.status === 'fulfilled' && r.value.qualified,
      );
      expect(qualified).toHaveLength(1);

      expect(await grants(referralId)).toHaveLength(2);
      expect(await outboxEvents()).toHaveLength(1);
      expect(await counters(referrer.id)).toEqual([{ period: expect.any(String), qualified_count: 1 }]);
    });
  });

  // ==========================================================================
  // 4. Zero is honestly disabled — the ledger proof
  // ==========================================================================

  describe('the honest zero', () => {
    it('writes NO loyalty row for either side when both values are zero', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      await qualifyFor(referee);

      // Qualification and both grants exist...
      expect((await referralRow(referralId)).status).toBe('qualified');
      expect(await grants(referralId)).toHaveLength(2);
      // ...and the ledger is untouched.
      expect(await ledgerRows(referralId)).toHaveLength(0);
    });

    it('consumes NO idempotency slot — a later real figure is still awardable', async () => {
      // The load-bearing half. `V32-DEC-016`: a zero row would occupy
      // ('referral', <id>, referral_referrer_reward) permanently, and the award
      // the business eventually approves would be silently deduplicated away.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      await qualifyFor(referee);
      expect(await ledgerRows(referralId)).toHaveLength(0);

      // Now the business sets a real figure and awards against the SAME
      // referral id, exactly as a future story would.
      const result = await dataSource.transaction((manager) =>
        ledger.award(
          {
            userId: referrer.id,
            reason: LOYALTY_REASONS.referralReferrerReward,
            referenceType: 'referral',
            referenceId: referralId,
            overridePoints: 25,
          },
          manager,
        ),
      );

      expect(result.awarded).toBe(true);
      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0].base_points).toBe(25);
    });

    it('does not even CALL the ledger for a zero side', async () => {
      // The DOMAIN's own guard, tested separately from the ledger's.
      //
      // The mutation pass found this gap: weakening
      // `awardIfPayable`'s early return did NOT fail the two cases above,
      // because `LoyaltyLedgerService.award` ALSO returns early at zero points.
      // Both tests were therefore proving the LEDGER's guard while appearing to
      // prove the domain's.
      //
      // ADR-037 §8 claims TWO independent reasons the idempotency slot stays
      // free -- the domain does not call, and the ledger would refuse anyway --
      // and a claim of independence is only worth making if each half is
      // observed on its own. This is the first half; the ledger's is already
      // covered by its own suite.
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);

      const port = app.get<{ award: (...args: unknown[]) => unknown }>(
        (await import('@beauclick/referral')).REFERRAL_LOYALTY_PORT,
      );
      const spy = jest.spyOn(port, 'award');

      await qualifyFor(referee);

      expect(spy).not.toHaveBeenCalled();
    });

    it('is NON-VACUOUS: the ledger IS called when a side is positive', async () => {
      // Without this, the case above would pass against a port that was never
      // wired up at all.
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);

      const port = app.get<{ award: (...args: unknown[]) => unknown }>(
        (await import('@beauclick/referral')).REFERRAL_LOYALTY_PORT,
      );
      const spy = jest.spyOn(port, 'award');

      withRewards(30, 15);
      await qualifyFor(referee);

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('pays correctly when a positive referrer value is configured', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(30, 0);
      await qualifyFor(referee);

      const grantRows = await grants(referralId);
      expect(grantRows.find((g) => g.side === 'referrer')).toMatchObject({ outcome: 'awarded', points: 30 });
      expect(grantRows.find((g) => g.side === 'referee')).toMatchObject({ outcome: 'disabled_zero', points: 0 });

      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: referrer.id,
        base_points: 30,
        reason: 'referral_referrer_reward',
      });
    });

    it('pays correctly when a positive referee value is configured', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(0, 15);
      await qualifyFor(referee);

      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: referee.id,
        base_points: 15,
        reason: 'referral_referee_reward',
      });
    });

    it('TWO DISTINCT REASONS let both people be paid against ONE referral id', async () => {
      // The proof `V32-DEC-016` demands, and the reason two reasons exist at
      // all: the ledger's idempotency is
      // UNIQUE(reference_type, reference_id, reason).
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(30, 15);
      await qualifyFor(referee);

      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.reason).sort()).toEqual([
        'referral_referee_reward',
        'referral_referrer_reward',
      ]);
      // Two different people, one referral id.
      expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([referrer.id, referee.id]));
    });

    it('is NON-VACUOUS: a SHARED reason collapses the two into one', async () => {
      // The negative control for the case above. If one reason were used for
      // both sides, the second award would hit the unique index and silently
      // return awarded:false -- which is precisely the bug `V32-DEC-016`
      // describes and the reason it mandates two.
      const referrer = await customer();
      const referee = await customer();
      const referralId = uuidv7();

      const first = await dataSource.transaction((manager) =>
        ledger.award(
          {
            userId: referrer.id,
            reason: LOYALTY_REASONS.referralReferrerReward,
            referenceType: 'referral',
            referenceId: referralId,
            overridePoints: 30,
          },
          manager,
        ),
      );
      // The SAME reason for the other person, which is what a single-reason
      // implementation would do.
      const second = await dataSource.transaction((manager) =>
        ledger.award(
          {
            userId: referee.id,
            reason: LOYALTY_REASONS.referralReferrerReward,
            referenceType: 'referral',
            referenceId: referralId,
            overridePoints: 15,
          },
          manager,
        ),
      );

      expect(first.awarded).toBe(true);
      // Deduplicated away. The referee would never have been paid.
      expect(second.awarded).toBe(false);
      expect(await ledgerRows(referralId)).toHaveLength(1);
    });

    it('a duplicate delivery produces ONE ledger effect per side', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(30, 15);
      await qualifyFor(referee);
      await qualifyFor(referee);

      expect(await ledgerRows(referralId)).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 5. The monthly cap
  // ==========================================================================

  describe('the referrer monthly cap', () => {
    /** Qualifies `count` distinct referees against one referrer. */
    async function qualifyMany(referrer: SeededUser, count: number) {
      const outcomes: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const referee = await customer();
        await pendingReferral(referrer, referee);
        const result = await qualifyFor(referee);
        outcomes.push(result.referrerOutcome ?? 'not_qualified');
      }
      return outcomes;
    }

    it('admits qualifications 1 through 10, and caps the 11th for the REFERRER only', async () => {
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(30, 15);

      const outcomes = await qualifyMany(referrer, REFERRAL_MONTHLY_CAP + 1);

      expect(outcomes.slice(0, REFERRAL_MONTHLY_CAP)).toEqual(Array(REFERRAL_MONTHLY_CAP).fill('awarded'));
      expect(outcomes[REFERRAL_MONTHLY_CAP]).toBe('capped');

      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP },
      ]);
    });

    it('at the cap the referral STILL qualifies and the referee is STILL paid', async () => {
      // `V32-DEC-019`'s owner correction, and the single most important
      // behaviour in this group: an invited customer must never lose their own
      // approved reward because of somebody else's activity.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(30, 15);

      await qualifyMany(referrer, REFERRAL_MONTHLY_CAP);

      const cappedReferee = await customer();
      const referralId = await pendingReferral(referrer, cappedReferee);
      const result = await qualifyFor(cappedReferee);

      // The referral qualified.
      expect(result.qualified).toBe(true);
      expect((await referralRow(referralId)).status).toBe('qualified');
      expect((await referralRow(referralId)).qualifying_booking_id).not.toBeNull();

      // BOTH grants exist, with different outcomes.
      const grantRows = await grants(referralId);
      expect(grantRows.find((g) => g.side === 'referrer')).toMatchObject({ outcome: 'capped' });
      expect(grantRows.find((g) => g.side === 'referee')).toMatchObject({ outcome: 'awarded', points: 15 });

      // The referrer got nothing; the referee got paid.
      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: cappedReferee.id, reason: 'referral_referee_reward' });

      // And the event is truthful about both.
      const events = await outboxEvents();
      const last = events[events.length - 1].payload;
      expect(last).toMatchObject({ referrerOutcome: 'capped', refereeOutcome: 'awarded' });
    });

    it('the NEXT JALALI month starts a fresh window — no lifetime cap', async () => {
      // `V32-DEC-035`: the period is the SOLAR HIJRI month, so the reset
      // instant is 1 Mehr 1405 -- 00:00 Tehran on 2026-09-23, which is
      // 2026-09-22T20:30Z -- and NOT 1 October.
      //
      // This is also the decisive case: both instants below are Gregorian
      // 2026-09, so a Gregorian implementation would keep one bucket and
      // refuse the eleventh qualification. The cap resetting here is only
      // correct under the ratified calendar.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(30, 15);

      await qualifyMany(referrer, REFERRAL_MONTHLY_CAP);

      // 00:01 Tehran on 1 Mehr 1405 -- still Gregorian September.
      ctx.referralClock.freeze(new Date('2026-09-22T20:31:00.000Z'));
      const outcomes = await qualifyMany(referrer, 1);

      expect(outcomes).toEqual(['awarded']);
      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP },
        { period: '1405-07', qualified_count: 1 },
      ]);
    });

    it('does NOT reset when only the GREGORIAN month changes', async () => {
      // The mirror image, and the half a Gregorian implementation passes
      // while getting the case above wrong. Mehr 1405 spans the Gregorian
      // September -> October boundary, so crossing it must change nothing.
      const referrer = await customer();
      withRewards(30, 15);

      // Inside Mehr 1405, before the Gregorian month end.
      ctx.referralClock.freeze(new Date('2026-09-30T20:29:00.000Z'));
      await qualifyMany(referrer, 1);

      // Two minutes later: Gregorian October, still Mehr 1405.
      ctx.referralClock.freeze(new Date('2026-09-30T20:31:00.000Z'));
      await qualifyMany(referrer, 1);

      // ONE bucket, not two -- the allowance did not reset.
      expect(await counters(referrer.id)).toEqual([{ period: '1405-07', qualified_count: 2 }]);
    });

    it('the cap is per referrer — one at the cap does not affect another', async () => {
      const capped = await customer();
      const other = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      withRewards(30, 15);

      await qualifyMany(capped, REFERRAL_MONTHLY_CAP);
      expect(await qualifyMany(capped, 1)).toEqual(['capped']);
      expect(await qualifyMany(other, 1)).toEqual(['awarded']);
    });

    it('CONCURRENT qualifications never exceed the cap', async () => {
      // The case a read-then-write cannot pass, and the reason `V32-DEC-019`
      // forbids that shape by name.
      const referrer = await customer();
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));

      const referees: SeededUser[] = [];
      for (let i = 0; i < REFERRAL_MONTHLY_CAP + 5; i += 1) {
        const referee = await customer();
        await pendingReferral(referrer, referee);
        referees.push(referee);
      }

      const results = await Promise.allSettled(referees.map((referee) => qualifyFor(referee)));
      const outcomes = results
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof qualifyFor>>> => r.status === 'fulfilled')
        .map((r) => r.value.referrerOutcome);

      // Every one qualified -- the cap constrains the REWARD, not the
      // qualification.
      expect(outcomes.filter((o) => o !== null)).toHaveLength(REFERRAL_MONTHLY_CAP + 5);
      expect(outcomes.filter((o) => o === 'capped')).toHaveLength(5);

      // The counter landed on exactly the cap, never above.
      expect(await counters(referrer.id)).toEqual([
        { period: '1405-06', qualified_count: REFERRAL_MONTHLY_CAP },
      ]);
    });

    it('duplicate delivery does not increment the cap twice', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));

      await qualifyFor(referee);
      await qualifyFor(referee);
      await qualifyFor(referee);

      expect(await counters(referrer.id)).toEqual([{ period: '1405-06', qualified_count: 1 }]);
    });
  });

  // ==========================================================================
  // 6. The transaction boundary
  // ==========================================================================

  describe('the transaction boundary', () => {
    it('a ROLLBACK removes the qualification, counter, grants, awards, and event', async () => {
      // The property that makes the whole design safe: nine effects commit or
      // none does. Proved by failing the transaction AFTER `qualify` returns,
      // which is the only honest way to observe a partial state if one existed.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(30, 15);

      await expect(
        dataSource.transaction(async (manager) => {
          await qualification.qualify(manager, { refereeUserId: referee.id, bookingId: uuidv7() });
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');

      expect((await referralRow(referralId)).status).toBe('pending');
      expect(await grants(referralId)).toHaveLength(0);
      expect(await ledgerRows(referralId)).toHaveLength(0);
      expect(await outboxEvents()).toHaveLength(0);
      expect(await counters(referrer.id)).toHaveLength(0);
    });

    it('is NON-VACUOUS: without the rollback the same effects are all present', async () => {
      // Without this, the case above would pass against an implementation that
      // simply never wrote anything.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      withRewards(30, 15);
      await qualifyFor(referee);

      expect((await referralRow(referralId)).status).toBe('qualified');
      expect(await grants(referralId)).toHaveLength(2);
      expect(await ledgerRows(referralId)).toHaveLength(2);
      expect(await outboxEvents()).toHaveLength(1);
      expect(await counters(referrer.id)).toHaveLength(1);
    });

    it('the ledger award runs on the CALLER\'s manager, not a second connection', async () => {
      // V3.2-B bug #2: a port opening its own connection inside a caller's
      // transaction needed 2N connections against a pool of 10, and past five
      // the suite STOPPED with no error. Observed here rather than asserted: if
      // the award ran on its own connection it could not see the uncommitted
      // referral row, and the rollback case above would leave a ledger row
      // behind.
      //
      // This asserts the same property from the other direction -- the award is
      // visible INSIDE the transaction before it commits.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      withRewards(30, 15);

      await dataSource.transaction(async (manager) => {
        await qualification.qualify(manager, { refereeUserId: referee.id, bookingId: uuidv7() });

        // Visible on the transaction's own manager...
        const inside = await manager.query(
          `SELECT count(*)::int AS n FROM loyalty.points_entries WHERE reference_type='referral' AND reference_id=$1`,
          [referralId],
        );
        expect(inside[0].n).toBe(2);

        // ...and NOT yet visible on a different connection.
        expect(await ledgerRows(referralId)).toHaveLength(0);
      });

      expect(await ledgerRows(referralId)).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 7. Privacy
  // ==========================================================================

  describe('privacy', () => {
    const contractsOf = () => app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
    const referralContract = () => contractsOf().find((c) => c.moduleKey === 'referral')!;
    const coverage = () => app.get(SubjectDataCoverageService);

    it('claims all six referral tables, with the ratified dispositions', async () => {
      const byTable = new Map(referralContract().tables.map((claim) => [claim.table, claim]));

      expect([...byTable.keys()].sort()).toEqual([
        'referral.claim_attempts',
        'referral.outbox_events',
        'referral.referral_codes',
        'referral.referrals',
        'referral.referrer_counters',
        'referral.reward_grants',
      ]);

      // `V32-DEC-019` ratifies these two directly.
      expect(byTable.get('referral.reward_grants')!.disposition).toBe('retained');
      expect(byTable.get('referral.reward_grants')!.reason).toBeTruthy();
      expect(byTable.get('referral.referrer_counters')!.disposition).toBe('subject_data');
    });

    it('passes the REAL boot-time coverage check', async () => {
      const result = await coverage().evaluate(contractsOf());
      expect(result.violations).toEqual([]);
      expect(result.tablesInDatabase).toBeGreaterThan(0);
    });

    it('is NON-VACUOUS: dropping EITHER new claim fails coverage', async () => {
      // One case per table, because a single check could pass by catching the
      // other one.
      const referralCatalogue = (await coverage().readCatalogue()).filter((t) => t.schema === 'referral');

      for (const dropped of ['referral.reward_grants', 'referral.referrer_counters']) {
        const stripped: SubjectDataContract[] = contractsOf().map((contract) =>
          contract.moduleKey === 'referral'
            ? { ...contract, tables: contract.tables.filter((claim) => claim.table !== dropped) }
            : contract,
        );
        const result = evaluateCoverage(referralCatalogue, stripped);
        expect(JSON.stringify(result.violations)).toContain(dropped.split('.')[1]);
      }
    });

    it("exports the subject's OWN grant outcomes, and no counterparty identity", async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);
      withRewards(30, 15);
      await qualifyFor(referee);

      for (const [subject, other, side] of [
        [referrer, referee, 'referrer'],
        [referee, referrer, 'referee'],
      ] as const) {
        const sections = await dataSource.transaction((manager) =>
          referralContract().exportSubjectData(manager, subject.id),
        );
        const rewardsSection = sections.find((s) => s.key === 'referral_rewards')!;

        expect(rewardsSection.rows).toHaveLength(1);
        expect(rewardsSection.rows[0]).toMatchObject({ side, outcome: 'awarded' });
        // Their own side and outcome; nothing about the other person.
        expect(Object.keys(rewardsSection.rows[0]).sort()).toEqual(['grantedAt', 'outcome', 'points', 'side']);

        const serialised = JSON.stringify(sections);
        expect(serialised).not.toContain(other.id);
        expect(serialised).not.toContain(other.phone);
      }
    });

    it('DELETES the cap counters on erasure and reports a truthful count', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      await qualifyFor(referee);

      expect(await counters(referrer.id)).toHaveLength(1);

      const outcome = await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, referrer.id, {
          userId: referrer.id,
          phoneAlias: `del:${referrer.id.replace(/-/g, '').slice(0, 26)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date('2026-10-01T00:00:00.000Z'),
        }),
      );

      expect(await counters(referrer.id)).toHaveLength(0);
      // The counter row plus the referral code row. A truthful count, summed
      // from what each statement actually reported.
      expect(outcome.deleted).toBeGreaterThanOrEqual(1);
    });

    it('RETAINS the reward grants on erasure, and says so', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      await qualifyFor(referee);

      const outcome = await dataSource.transaction((manager) =>
        referralContract().eraseSubjectData(manager, referrer.id, {
          userId: referrer.id,
          phoneAlias: `del:${referrer.id.replace(/-/g, '').slice(0, 26)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date('2026-10-01T00:00:00.000Z'),
        }),
      );

      // The grant survives, because it explains a retained loyalty entry.
      expect(await grants(referralId)).toHaveLength(2);
      expect(outcome.retained.map((r) => r.table)).toContain('referral.reward_grants');
      // And the referral row's erased side is tombstoned, so the retained grant
      // stays coherent with an identity that is gone.
      const [row] = await dataSource.query(
        'SELECT referrer_erased_at FROM referral.referrals WHERE id = $1',
        [referralId],
      );
      expect(row.referrer_erased_at).not.toBeNull();
    });
  });

  // ==========================================================================
  // 8. The financial and Story #28 boundaries
  // ==========================================================================

  describe('boundaries', () => {
    it('leaves the financial role boundary exactly as it was', async () => {
      // `loyalty.points_entries` is owned by `beauclick_app`;
      // `financial.ledger_entries` is a DIFFERENT object owned by
      // `beauclick_financial_owner`. Story #12 touches neither schema.
      const [owners] = await dataSource.query(`
        SELECT
          (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'loyalty.points_entries'::regclass) AS loyalty_owner,
          has_schema_privilege('beauclick_app', 'financial', 'USAGE') AS app_financial_usage
      `);

      expect(owners.loyalty_owner).toBe('beauclick_app');
      expect(owners.app_financial_usage).toBe(false);
    });

    it('writes no financial ledger row, ever', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);
      withRewards(30, 15);

      await qualifyFor(referee);

      // The referral path moves POINTS, never money (`V32-DEC-016`: the reward
      // unit is loyalty points only -- no cash, no second ledger, no direct
      // balance write).
      const financial = await dataSource
        .query('SELECT 1 FROM financial.ledger_entries')
        .catch(() => 'no access');
      expect(financial === 'no access' || (financial as unknown[]).length === 0).toBe(true);
    });

    it('creates no negative ledger row and no reversal artefact', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      withRewards(30, 15);
      await qualifyFor(referee);

      const rows = await ledgerRows(referralId);
      expect(rows.every((r) => r.points > 0)).toBe(true);

      // No Story #28 vocabulary anywhere in what was written.
      const everything = JSON.stringify([await grants(referralId), await outboxEvents()]);
      expect(everything).not.toMatch(/revers|clawback|refund/i);
    });

    it('emits ReferralQualified and no other referral event', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);
      await qualifyFor(referee);

      const types = (await outboxEvents()).map((e) => e.event_type);
      expect(types).toEqual([ReferralQualified.name]);
    });

    it('puts no code, phone, or prose in the outbox payload', async () => {
      const referrer = await customer();
      const referee = await customer();
      await pendingReferral(referrer, referee);

      // Give the referrer a real code, so there is something to leak.
      const codeResponse = await dataSource.query(
        `INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3) RETURNING code`,
        [uuidv7(), referrer.id, 'A1B2C3D4E5'],
      );
      const code = codeResponse[0].code as string;

      await qualifyFor(referee);

      const serialised = JSON.stringify(await outboxEvents());
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(referrer.phone);
      expect(serialised).not.toContain(referee.phone);

      // Non-vacuity: the payload IS present and does carry the ids, so the
      // absence above is a real absence rather than an empty scan.
      expect(serialised).toContain(referrer.id);
    });
  });
});
