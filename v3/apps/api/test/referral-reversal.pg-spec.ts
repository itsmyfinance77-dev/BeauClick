import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { OutboxRelay } from '@beauclick/events';
import { OrderService } from '@beauclick/commerce';
import { LOYALTY_REASONS, LoyaltyLedgerService, MembershipService, TierService } from '@beauclick/loyalty';
import {
  REFERRAL_MONTHLY_CAP,
  REFERRAL_REWARD_CONFIG,
  ReferralQualificationService,
  ReferralReversalService,
  ReferralRewardConfig,
  ReferralSubjectDataContract,
} from '@beauclick/referral';
import { ReferralReversed } from '@beauclick/event-contracts';
import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
  tombstoneFor,
} from '@beauclick/subject-data';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

const DAY_MS = 86_400_000;
const ORDER_TOTAL = 100_000;

/**
 * A fixed id for the seeded bronze tier, so the benefit rows that hang off it
 * can be written in the same statement block without a round trip.
 */
const BRONZE_TIER_ID = '00000000-0000-4000-8000-0000000b0117';

/**
 * Referral reversal and the loyalty clawback, against real PostgreSQL —
 * V3.2-C Story #28 (ADR-038).
 *
 * ## Why none of this can be proved anywhere else
 *
 * Every guarantee this story makes is a **database**, **transaction** or
 * **concurrency** guarantee, and pg-mem honours none of them: no triggers, no
 * partial unique indexes under concurrent transactions, no `FOR SHARE`, and it
 * does not honour `ROLLBACK`. A compare-and-swap, an append-only ledger, a
 * transaction that must roll back *whole*, and a row lock that closes an
 * ordering race are exactly the four things a fake would agree with itself
 * about.
 *
 * ## Both configured reward values are ZERO, so most of the story is absence
 *
 * `V32-DEC-016` sets both to 0 and this story does not change them. So the
 * *paying* path — a positive award, a real negative clawback, a balance driven
 * below zero — is proved by **injecting positive values through the config
 * token**, exactly as the qualification suite does, and never by editing a
 * default. Editing one would be inventing economics no owner approved and
 * would leave the repository one careless merge from shipping them.
 */
describePg('referral reversal — full refund, clawback, convergence (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let qualification: ReferralQualificationService;
  let reversal: ReferralReversalService;
  let ledger: LoyaltyLedgerService;
  let tiers: TierService;
  let memberships: MembershipService;
  let orders: OrderService;
  let rewards: { referrerPoints: number; refereePoints: number };

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    qualification = app.get(ReferralQualificationService);
    reversal = app.get(ReferralReversalService);
    ledger = app.get(LoyaltyLedgerService);
    tiers = app.get(TierService);
    memberships = app.get(MembershipService);
    orders = app.get(OrderService);
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

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Temporarily overrides the two configured reward values.
   *
   * The same mechanism the qualification suite uses and for the same reason:
   * `REFERRAL_REWARD_CONFIG` is bound to an object with GETTERS onto
   * `LoyaltyConfig.policy`, so it cannot simply be assigned — and a test that
   * edited the production default to make ledger rows appear would be inventing
   * economics no owner approved.
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
    return seedUser(app, dataSource, `+9891610${String(seq).padStart(5, '0')}`);
  }

  /** A pending attribution, written directly — Story #27's claim route is not under test here. */
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
   * writing a status here: the whole point of ADR-038 §2 is that the platform's
   * own statement computes full-versus-partial, so a test that set
   * `status = 'refunded'` by hand would be asserting against a rule it had just
   * bypassed.
   */
  async function paidOrder(
    bookingId: string,
    customerId: string,
    total = ORDER_TOTAL,
    sourceType: 'booking' | 'direct' = 'booking',
  ): Promise<string> {
    const orderId = uuidv7();
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, discount_total_toman, fee_total_toman, total_toman, paid_at)
       VALUES ($1, $2, $3, $4, 'professional', $5, 'paid', 'IRT', $6, 0, 0, $6, now())`,
      [orderId, sourceType, bookingId, customerId, uuidv7(), total],
    );
    return orderId;
  }

  /** Qualification, exactly as the handler runs it: one transaction, caller's manager. */
  async function qualifyFor(referee: SeededUser, bookingId: string) {
    return dataSource.transaction((manager) =>
      qualification.qualify(manager, { refereeUserId: referee.id, bookingId }),
    );
  }

  /** Reversal, exactly as the `OrderRefunded` handler runs it. */
  async function reverseFor(orderId: string) {
    return dataSource.transaction((manager) => reversal.reverseForRefundedOrder(manager, orderId));
  }

  /**
   * The whole ordinary chain: a real refund through commerce, then the reversal
   * as the handler performs it.
   *
   * `recordRefund` is what computes `refunded` versus `partially_refunded` and
   * emits `OrderRefunded`, so calling it is what makes the full-versus-partial
   * distinction a real one rather than a fixture.
   */
  async function refundAndReverse(orderId: string, amount: number) {
    const recorded = await orders.recordRefund(orderId, amount, uuidv7());
    expect(recorded).toBe(true);
    return reverseFor(orderId);
  }

  async function referralRow(id: string) {
    const [row] = await dataSource.query('SELECT * FROM referral.referrals WHERE id = $1', [id]);
    return row as {
      status: string;
      qualified_at: Date | null;
      qualifying_booking_id: string | null;
      reversed_at: Date | null;
      reversal_order_id: string | null;
    };
  }

  async function reversals(referralId: string) {
    return dataSource.query(
      `SELECT side, outcome, points, ledger_reason, recipient_user_id
         FROM referral.reward_reversals WHERE referral_id = $1 ORDER BY side`,
      [referralId],
    ) as Promise<
      Array<{ side: string; outcome: string; points: number; ledger_reason: string; recipient_user_id: string }>
    >;
  }

  async function ledgerRows(referralId: string) {
    return dataSource.query(
      `SELECT user_id, points, base_points, multiplier_bp, reason FROM loyalty.points_entries
        WHERE reference_type = 'referral' AND reference_id = $1 ORDER BY reason`,
      [referralId],
    ) as Promise<
      Array<{ user_id: string; points: number; base_points: number; multiplier_bp: number; reason: string }>
    >;
  }

  async function outboxEvents(eventType?: string) {
    const rows = (await dataSource.query(
      'SELECT event_type, event_version, payload FROM referral.outbox_events ORDER BY id',
    )) as Array<{ event_type: string; event_version: number; payload: Record<string, unknown> }>;
    return eventType ? rows.filter((row) => row.event_type === eventType) : rows;
  }

  async function notificationsFor(userId: string) {
    return dataSource.query(
      `SELECT template_key, channel, category, status, payload, entity_type, entity_id
         FROM notification.notifications WHERE user_id = $1 ORDER BY template_key`,
      [userId],
    ) as Promise<
      Array<{
        template_key: string;
        channel: string;
        category: string;
        status: string;
        payload: Record<string, unknown>;
        entity_type: string;
        entity_id: string;
      }>
    >;
  }

  /**
   * A qualified referral whose booking has a paid order, with real points on
   * both sides.
   *
   * The fixture most of this suite starts from, because a story about taking
   * points back is only meaningfully tested where points were given.
   */
  async function awardedReferral(options: { referrerPoints?: number; refereePoints?: number } = {}) {
    const referrer = await customer();
    const referee = await customer();
    const referralId = await pendingReferral(referrer, referee);
    const bookingId = uuidv7();
    const orderId = await paidOrder(bookingId, referee.id);

    withRewards(options.referrerPoints ?? 50, options.refereePoints ?? 30);
    const result = await qualifyFor(referee, bookingId);
    expect(result.qualified).toBe(true);

    return { referrer, referee, referralId, bookingId, orderId };
  }

  // ==========================================================================
  // 1. A full refund reverses, and what it actually records
  // ==========================================================================

  describe('a full refund of the qualifying booking order', () => {
    it('reverses an AWARDED referrer grant with a negative ledger row', async () => {
      const { referrer, referralId, orderId } = await awardedReferral({ referrerPoints: 50, refereePoints: 0 });

      const result = await refundAndReverse(orderId, ORDER_TOTAL);
      expect(result.reversed).toBe(true);
      expect(result.referrerOutcome).toBe('reversed');

      const rows = await ledgerRows(referralId);
      const negative = rows.find((row) => row.reason === LOYALTY_REASONS.referralReferrerReversal);
      expect(negative).toBeDefined();
      expect(negative?.points).toBe(-50);
      expect(negative?.user_id).toBe(referrer.id);
    });

    it('reverses an AWARDED referee grant with a negative ledger row', async () => {
      const { referee, referralId, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });

      const result = await refundAndReverse(orderId, ORDER_TOTAL);
      expect(result.refereeOutcome).toBe('reversed');

      const negative = (await ledgerRows(referralId)).find(
        (row) => row.reason === LOYALTY_REASONS.referralRefereeReversal,
      );
      expect(negative?.points).toBe(-30);
      expect(negative?.user_id).toBe(referee.id);
    });

    it('reverses BOTH sides in ONE transaction, with the state and facts moving together', async () => {
      const { referralId, orderId } = await awardedReferral();

      await refundAndReverse(orderId, ORDER_TOTAL);

      const row = await referralRow(referralId);
      expect(row.status).toBe('reversed');
      expect(row.reversed_at).not.toBeNull();
      // The AUTHORITATIVE CAUSE, not "an" order.
      expect(row.reversal_order_id).toBe(orderId);
      // The qualification facts survive: `V32-DEC-017` reverses the reward,
      // never the record that it was earned.
      expect(row.qualified_at).not.toBeNull();
      expect(row.qualifying_booking_id).not.toBeNull();

      const negatives = (await ledgerRows(referralId)).filter((r) => r.points < 0);
      expect(negatives).toHaveLength(2);
    });

    it('writes BOTH reversal rows, under the two DISTINCT reasons', async () => {
      const { referrer, referee, referralId, orderId } = await awardedReferral();

      await refundAndReverse(orderId, ORDER_TOTAL);

      expect(await reversals(referralId)).toEqual([
        {
          side: 'referee',
          outcome: 'reversed',
          points: 30,
          ledger_reason: LOYALTY_REASONS.referralRefereeReversal,
          recipient_user_id: referee.id,
        },
        {
          side: 'referrer',
          outcome: 'reversed',
          points: 50,
          ledger_reason: LOYALTY_REASONS.referralReferrerReversal,
          recipient_user_id: referrer.id,
        },
      ]);
    });

    it('leaves the ORIGINAL positive rows untouched — the ledger is append-only', async () => {
      const { referralId, orderId } = await awardedReferral();

      const before = (await ledgerRows(referralId)).filter((row) => row.points > 0);
      expect(before).toHaveLength(2);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const after = (await ledgerRows(referralId)).filter((row) => row.points > 0);
      // Identical rows, not merely the same count: a mutation that halved a
      // value or flipped a sign would keep the count and fail here.
      expect(after).toEqual(before);
      expect(await ledgerRows(referralId)).toHaveLength(4);
    });
  });

  // ==========================================================================
  // 2. The amount comes from what was PERSISTED, never from configuration
  // ==========================================================================

  describe('the clawback amount', () => {
    it('comes from the persisted award, not from the CURRENT configuration', async () => {
      const { referralId, orderId } = await awardedReferral({ referrerPoints: 50, refereePoints: 30 });

      // The business raises both rewards between the booking and the refund --
      // months apart in production, one line here. A reversal computed from
      // configuration would take back 500 and 300.
      withRewards(500, 300);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const rows = await ledgerRows(referralId);
      expect(rows.find((r) => r.reason === LOYALTY_REASONS.referralReferrerReversal)?.points).toBe(-50);
      expect(rows.find((r) => r.reason === LOYALTY_REASONS.referralRefereeReversal)?.points).toBe(-30);
    });

    it('survives the reward being switched OFF entirely after qualification', async () => {
      const { referralId, orderId } = await awardedReferral({ referrerPoints: 50, refereePoints: 30 });

      // Back to the production values. A reversal reading configuration would
      // now claw back nothing at all -- the failure mode that leaves the points
      // in place and looks like success.
      withRewards(0, 0);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const negatives = (await ledgerRows(referralId)).filter((r) => r.points < 0);
      expect(negatives.map((r) => r.points).sort((a, b) => a - b)).toEqual([-50, -30].sort((a, b) => a - b));
    });

    it('reverses what was CREDITED, not the base, when a tier multiplier applied', async () => {
      /**
       * The finding that reshaped ADR-038 §5, and the case that makes it
       * demonstrable rather than merely argued.
       *
       * `award()` credits `round(base * multiplierBp / 10000)` using the
       * recipient's membership benefits at award time — so `reward_grants.points`
       * is the **base** and the ledger row is what the customer actually
       * received. With no benefit seeded the two are equal, and a clawback that
       * reversed the grant's figure would look perfectly correct: the residue
       * only appears for customers whose tier earned them a bonus, which is
       * exactly why nothing would ever report it.
       *
       * So a real 1.2x benefit is seeded. Base 50 credits 60; the reversal must
       * be −60. An implementation reading the grant writes −50 and leaves 10
       * points behind, permanently.
       */
      await dataSource.query(
        `INSERT INTO loyalty.tiers (id, slug, name, threshold_points, sort_order, is_active)
         VALUES ($1, 'bronze', 'bronze', 0, 0, true)`,
        [BRONZE_TIER_ID],
      );
      await dataSource.query(
        `INSERT INTO loyalty.benefits (id, source_type, source_id, benefit_type, label, config, is_active)
         VALUES ($1, 'tier', $2, 'bonus_points_multiplier', 'x1.2', '{"multiplierBp": 12000}'::jsonb, true)`,
        [uuidv7(), BRONZE_TIER_ID],
      );

      const { referralId, orderId, referrer } = await awardedReferral({ referrerPoints: 50, refereePoints: 0 });

      const positive = (await ledgerRows(referralId)).find(
        (r) => r.reason === LOYALTY_REASONS.referralReferrerReward,
      );
      // The multiplier genuinely applied -- without this the whole case is
      // vacuous, and it silently was until a mutation probe said so.
      expect(positive?.multiplier_bp).toBe(12000);
      expect(positive?.base_points).toBe(50);
      expect(positive?.points).toBe(60);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const negative = (await ledgerRows(referralId)).find(
        (r) => r.reason === LOYALTY_REASONS.referralReferrerReversal,
      );
      // The credited amount, not the base. This is the assertion the whole
      // grant-decides-whether / ledger-decides-how-much split exists for.
      expect(negative?.points).toBe(-60);
      expect(negative?.base_points).toBe(-50);
      // The ORIGINAL multiplier, copied rather than recomputed, so a later
      // benefit change cannot make a past reversal look wrong.
      expect(negative?.multiplier_bp).toBe(12000);

      // And the net effect on the person is exactly zero -- which reversing the
      // base would have missed by the whole bonus.
      expect(await ledger.balance(referrer.id)).toBe(0);
    });

    it('still cross-checks the grant against the ledger when a multiplier applied', async () => {
      // The cross-check compares the grant's points against the ledger row's
      // BASE points, not its credited points -- so a multiplier must not make
      // it fire. If it did, every referral belonging to a benefited customer
      // would fail to reverse at all.
      await dataSource.query(
        `INSERT INTO loyalty.tiers (id, slug, name, threshold_points, sort_order, is_active)
         VALUES ($1, 'bronze', 'bronze', 0, 0, true)`,
        [BRONZE_TIER_ID],
      );
      await dataSource.query(
        `INSERT INTO loyalty.benefits (id, source_type, source_id, benefit_type, label, config, is_active)
         VALUES ($1, 'tier', $2, 'bonus_points_multiplier', 'x1.2', '{"multiplierBp": 12000}'::jsonb, true)`,
        [uuidv7(), BRONZE_TIER_ID],
      );

      const { orderId, referralId } = await awardedReferral({ referrerPoints: 50, refereePoints: 30 });

      await expect(refundAndReverse(orderId, ORDER_TOTAL)).resolves.toMatchObject({ reversed: true });
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 3. What must NOT reverse
  // ==========================================================================

  describe('what does not reverse', () => {
    it('a PARTIAL refund reverses nothing', async () => {
      const { referralId, orderId } = await awardedReferral();

      const result = await refundAndReverse(orderId, ORDER_TOTAL / 2);
      expect(result.reversed).toBe(false);

      expect((await referralRow(referralId)).status).toBe('qualified');
      expect(await reversals(referralId)).toHaveLength(0);
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(0);
    });

    it('a sequence of partials DOES reverse once it completes the total', async () => {
      // The case the story names: `recordRefund` emits the same event for both,
      // so a handler branching on the event's existence reverses on the first
      // partial and a handler branching on the amount never reverses at all.
      // Only the ORDER's status distinguishes them.
      const { referralId, orderId } = await awardedReferral();

      expect((await refundAndReverse(orderId, 40_000)).reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('qualified');

      expect((await refundAndReverse(orderId, 60_000)).reversed).toBe(true);
      expect((await referralRow(referralId)).status).toBe('reversed');
    });

    it('an UNRELATED order reverses nothing', async () => {
      const { referralId } = await awardedReferral();

      const other = await customer();
      const otherOrderId = await paidOrder(uuidv7(), other.id);

      const result = await refundAndReverse(otherOrderId, ORDER_TOTAL);
      expect(result.reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('qualified');
    });

    it('an order for a DIFFERENT booking of the same customer reverses nothing', async () => {
      // The sharpest of the "wrong source" cases: same person, same order
      // shape, different booking. A handler that matched on the customer rather
      // than on `qualifying_booking_id` would reverse here.
      const { referee, referralId } = await awardedReferral();

      const secondBookingId = uuidv7();
      const secondOrderId = await paidOrder(secondBookingId, referee.id);

      const result = await refundAndReverse(secondOrderId, ORDER_TOTAL);
      expect(result.reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('qualified');
    });

    it('a DIRECT order reverses nothing, even when its source id collides with the booking', async () => {
      // `source_id` means different things for `booking` and `direct` orders,
      // so matching one against `qualifying_booking_id` without checking
      // `source_type` is comparing two namespaces and hoping. Constructed here
      // so the collision is certain rather than astronomically unlikely.
      const { referee, referralId, bookingId } = await awardedReferral();

      const directOrderId = await paidOrder(bookingId, referee.id, ORDER_TOTAL, 'direct');
      const result = await refundAndReverse(directOrderId, ORDER_TOTAL);

      expect(result.reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('qualified');
    });

    it('a MISSING order reverses nothing and raises nothing', async () => {
      // A raise here would leave the outbox row unpublished and retrying
      // forever against an order that will never exist.
      const result = await reverseFor(uuidv7());
      expect(result.reversed).toBe(false);
    });

    it('a PENDING referral is not reversible', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      const result = await refundAndReverse(orderId, ORDER_TOTAL);
      expect(result.reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('pending');
    });
  });

  // ==========================================================================
  // 4. `duplicate_charge` — structurally excluded, proved end to end
  // ==========================================================================

  describe('a duplicate-charge correction', () => {
    it('never produces an OrderRefunded event, and so never reverses', async () => {
      const { referralId, orderId } = await awardedReferral();

      // The real handler chain, not a stub: `RefundCompletedCommerceHandler`
      // returns before `recordRefund` for a duplicate charge, and that handler
      // is `recordRefund`'s only production caller -- so the order's status
      // never moves and no `OrderRefunded` is ever emitted. The exclusion is
      // structural (ADR-038 §3), and this is what proves it rather than a field
      // nothing can set.
      await dataSource.query(
        `INSERT INTO payment.outbox_events
           (id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'payment', $2, 'RefundCompleted', 1, $3::jsonb)`,
        [
          uuidv7(),
          orderId,
          JSON.stringify({
            refundId: uuidv7(),
            paymentIntentId: uuidv7(),
            orderId,
            amountToman: ORDER_TOTAL,
            kind: 'duplicate_charge',
            completedAt: new Date().toISOString(),
          }),
        ],
      );

      await relay.drain();

      const [order] = await dataSource.query('SELECT status, refunded_total_toman FROM commerce.orders WHERE id = $1', [
        orderId,
      ]);
      expect(order.status).toBe('paid');
      expect(Number(order.refunded_total_toman)).toBe(0);

      const commerceEvents = await dataSource.query(
        "SELECT event_type FROM commerce.outbox_events WHERE event_type = 'OrderRefunded'",
      );
      expect(commerceEvents).toHaveLength(0);

      expect((await referralRow(referralId)).status).toBe('qualified');
      expect(await reversals(referralId)).toHaveLength(0);
    });

    it('does not reverse even when it arrives AFTER a legitimate partial refund', async () => {
      const { referralId, orderId } = await awardedReferral();

      await refundAndReverse(orderId, ORDER_TOTAL / 2);

      await dataSource.query(
        `INSERT INTO payment.outbox_events
           (id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'payment', $2, 'RefundCompleted', 1, $3::jsonb)`,
        [
          uuidv7(),
          orderId,
          JSON.stringify({
            refundId: uuidv7(),
            paymentIntentId: uuidv7(),
            orderId,
            amountToman: ORDER_TOTAL / 2,
            kind: 'duplicate_charge',
            completedAt: new Date().toISOString(),
          }),
        ],
      );
      await relay.drain();

      // The duplicate charge must not have completed the partial refund into a
      // full one -- which is exactly what recording it against the order would
      // have done.
      const [order] = await dataSource.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId]);
      expect(order.status).toBe('partially_refunded');
      expect((await referralRow(referralId)).status).toBe('qualified');
    });
  });

  // ==========================================================================
  // 5. Idempotency and concurrency
  // ==========================================================================

  describe('replay and concurrency', () => {
    it('a REDELIVERED refund changes nothing', async () => {
      const { referralId, orderId } = await awardedReferral();

      await refundAndReverse(orderId, ORDER_TOTAL);
      const afterFirst = await referralRow(referralId);

      // The reversal path again, as a redelivered `OrderRefunded` would drive
      // it. The refund itself is not repeated -- commerce would refuse it -- but
      // the referral side must be independently safe.
      const second = await reverseFor(orderId);
      expect(second.reversed).toBe(false);

      const afterSecond = await referralRow(referralId);
      expect(afterSecond.reversed_at).toEqual(afterFirst.reversed_at);
      expect(await reversals(referralId)).toHaveLength(2);
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(2);
      expect(await outboxEvents(ReferralReversed.name)).toHaveLength(1);
    });

    it('CONCURRENT deliveries produce exactly ONE reversal', async () => {
      const { referralId, orderId } = await awardedReferral();
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      // Genuinely overlapping transactions, not sequential calls: the CAS is
      // the only thing standing between them, and this is the shape that finds
      // out whether it is.
      const results = await Promise.all([reverseFor(orderId), reverseFor(orderId), reverseFor(orderId)]);

      expect(results.filter((r) => r.reversed)).toHaveLength(1);
      expect(await reversals(referralId)).toHaveLength(2);
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(2);
      expect(await outboxEvents(ReferralReversed.name)).toHaveLength(1);
    });

    it('the CAS reads the affected-row count correctly, not `result.length`', async () => {
      // The regression this repository has shipped twice. TypeORM's postgres
      // driver returns `[rows, rowCount]` for UPDATE even with RETURNING, so
      // `result.length` is 2 whether or not anything matched -- and a guard
      // reading it would report `reversed: true` for a referral that does not
      // exist. There is no referral here at all.
      const stranger = await customer();
      const orderId = await paidOrder(uuidv7(), stranger.id);
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      expect((await reverseFor(orderId)).reversed).toBe(false);
      expect(
        await dataSource.query('SELECT count(*)::int AS n FROM referral.reward_reversals'),
      ).toEqual([{ n: 0 }]);
    });

    it('the ledger reversal slot is a SECOND, independent guard', async () => {
      // Belt and braces, and the braces are checked: even with the referral row
      // forced back to `qualified` -- which the trigger forbids through normal
      // paths -- the ledger's UNIQUE(reference_type, reference_id, reason) on
      // the reversal reason refuses a second negative row.
      const { referralId, orderId, referrer } = await awardedReferral({ referrerPoints: 50, refereePoints: 0 });
      await refundAndReverse(orderId, ORDER_TOTAL);

      await expect(
        ledger.reverse({
          referenceType: 'referral',
          referenceId: referralId,
          originalReason: LOYALTY_REASONS.referralReferrerReward,
          reversalReason: LOYALTY_REASONS.referralReferrerReversal,
        }),
      ).resolves.toEqual({ reversed: false, points: 0 });

      expect(await ledger.balance(referrer.id)).toBe(0);
    });
  });

  // ==========================================================================
  // 6. The honest zero, in the reversal direction
  // ==========================================================================

  describe('a side with nothing to reverse', () => {
    it('writes NO zero-value ledger row for a disabled_zero side', async () => {
      // Both configured values at 0 -- the production default. Qualification
      // records both grants as `disabled_zero` and writes no ledger row, so
      // there is nothing to claw back and nothing must be invented.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      await qualifyFor(referee, bookingId);
      const result = await refundAndReverse(orderId, ORDER_TOTAL);

      expect(result.reversed).toBe(true);
      expect(result.referrerOutcome).toBe('nothing_to_reverse');
      expect(result.refereeOutcome).toBe('nothing_to_reverse');
      expect(await ledgerRows(referralId)).toHaveLength(0);
    });

    it('leaves the reversal idempotency slot FREE, so a later real award is still reversible', async () => {
      // The reason a zero row would be a bug rather than clutter. A
      // `('referral', <id>, referral_referrer_reversal)` row written now would
      // silently deduplicate away the clawback of a figure the business
      // approves later -- surfacing as "we refunded the order and the points
      // are still there", long after the code that caused it shipped.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      await qualifyFor(referee, bookingId);
      await refundAndReverse(orderId, ORDER_TOTAL);

      // The business approves a figure and it is awarded against the SAME
      // referral id -- the property `V32-DEC-016` protects on the way in.
      await ledger.award({
        userId: referrer.id,
        reason: LOYALTY_REASONS.referralReferrerReward,
        referenceType: 'referral',
        referenceId: referralId,
        overridePoints: 50,
      });

      // And it is still reversible, because the slot was never occupied.
      await expect(
        ledger.reverse({
          referenceType: 'referral',
          referenceId: referralId,
          originalReason: LOYALTY_REASONS.referralReferrerReward,
          reversalReason: LOYALTY_REASONS.referralReferrerReversal,
        }),
      ).resolves.toEqual({ reversed: true, points: 50 });
    });

    it('writes NO negative row for a CAPPED referrer, and still reverses the referee', async () => {
      // The independence `V32-DEC-019`'s owner correction requires, carried
      // through to the reversal: one side had a reward to take back and the
      // other never had one, and the transaction handles both truthfully.
      const referrer = await customer();
      withRewards(50, 30);

      // Spend the referrer's monthly cap. The period key is read from the
      // counter the qualification path itself writes, never rebuilt here: it is
      // a JALALI year-month (`V32-DEC-035`), and a test that computed a
      // Gregorian one would silently fill a different bucket and prove nothing.
      await dataSource.query(
        `INSERT INTO referral.referrer_counters (referrer_user_id, period, qualified_count)
         VALUES ($1, $2, $3)`,
        [referrer.id, await currentPeriod(), REFERRAL_MONTHLY_CAP],
      );

      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      const qualified = await qualifyFor(referee, bookingId);
      expect(qualified.referrerOutcome).toBe('capped');
      expect(qualified.refereeOutcome).toBe('awarded');

      const result = await refundAndReverse(orderId, ORDER_TOTAL);

      expect(result.referrerOutcome).toBe('nothing_to_reverse');
      expect(result.refereeOutcome).toBe('reversed');

      expect(await reversals(referralId)).toEqual([
        {
          side: 'referee',
          outcome: 'reversed',
          points: 30,
          ledger_reason: LOYALTY_REASONS.referralRefereeReversal,
          recipient_user_id: referee.id,
        },
        {
          side: 'referrer',
          outcome: 'nothing_to_reverse',
          points: 0,
          ledger_reason: LOYALTY_REASONS.referralReferrerReversal,
          recipient_user_id: referrer.id,
        },
      ]);

      const negatives = (await ledgerRows(referralId)).filter((r) => r.points < 0);
      expect(negatives).toHaveLength(1);
      expect(negatives[0].user_id).toBe(referee.id);
    });

    it('records BOTH rows even when neither side moved a point', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      await qualifyFor(referee, bookingId);
      await refundAndReverse(orderId, ORDER_TOTAL);

      const rows = await reversals(referralId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.outcome === 'nothing_to_reverse' && r.points === 0)).toBe(true);
    });
  });

  /** The current Jalali cap period, read from the counter the qualification writes. */
  async function currentPeriod(): Promise<string> {
    const probeReferrer = await customer();
    const probeReferee = await customer();
    await pendingReferral(probeReferrer, probeReferee);
    await qualifyFor(probeReferee, uuidv7());
    const [row] = await dataSource.query(
      'SELECT period FROM referral.referrer_counters WHERE referrer_user_id = $1',
      [probeReferrer.id],
    );
    return (row as { period: string }).period;
  }

  // ==========================================================================
  // 6b. The monthly cap slot stays spent — `V32-DEC-036`
  // ==========================================================================

  describe('the referrer monthly cap counter', () => {
    /**
     * Every row of the counter, verbatim — including PostgreSQL's own `xmin`.
     *
     * ## Why `xmin` and not `updated_at`
     *
     * `updated_at` was the obvious choice and is the WRONG one, which a
     * mutation probe established rather than review: it is a TypeORM
     * `@UpdateDateColumn`, set by **application code**, and the column's
     * `DEFAULT now()` fires only on INSERT. A raw-SQL `UPDATE` — which is
     * exactly how this counter is written, because the cap has to be one
     * conditional statement — leaves it completely untouched. An assertion on
     * `updated_at` would therefore have passed while the row underneath it was
     * being rewritten.
     *
     * `xmin` is the system column holding the id of the transaction that
     * produced the current row version. **Any** write produces a new version
     * and a new `xmin`: a decrement, a recomputation that happens to land on
     * the same number, a decrement-then-restore, and a bare
     * `SET qualified_count = qualified_count` are all caught, and a count
     * comparison alone catches none of them.
     */
    async function counterRows(referrerUserId: string) {
      return dataSource.query(
        `SELECT period, qualified_count, xmin::text AS row_version
           FROM referral.referrer_counters
          WHERE referrer_user_id = $1 ORDER BY period`,
        [referrerUserId],
      ) as Promise<Array<{ period: string; qualified_count: number; row_version: string }>>;
    }

    /**
     * `V32-DEC-036`: **the slot stays spent.** The cap counts *qualifications
     * the platform successfully processed*, not *rewards that survived a
     * refund*.
     *
     * ## Why this needs a database test at all
     *
     * `referral-reversal.spec.ts` already asserts that the reversal service's
     * source does not contain the string `referrer_counters`. That proves the
     * code does not **mention** the table; it cannot prove a **row survived**,
     * and it would pass unchanged if a reversal wrote the counter through the
     * entity, through a repository, or from a handler two files away. The
     * guarantee is about a row, so it is asserted about a row.
     *
     * ## Why the abuse boundary depends on it
     *
     * Returning the slot would make qualification/refund **cycling** possible:
     * a referrer colluding with invitees who book and refund could reuse one
     * slot indefinitely, and `V32-DEC-019` calls the monthly cap the
     * *bounded-exposure control* for an erase-and-re-register gap it accepts
     * knowingly. A cap that a refund can refund is not a cap.
     */
    it('is UNCHANGED by a reversal in the SAME Jalali month', async () => {
      // Frozen inside Shahrivar 1405, so the qualification and the refund are
      // unambiguously in one cap period.
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));

      const { referrer, orderId } = await awardedReferral();

      const before = await counterRows(referrer.id);
      expect(before).toHaveLength(1);
      expect(before[0].qualified_count).toBe(1);

      await refundAndReverse(orderId, ORDER_TOTAL);

      // Byte-identical, row version included. Not "still 1" -- untouched.
      expect(await counterRows(referrer.id)).toEqual(before);
    });

    it('is UNCHANGED by a reversal in a LATER Jalali month, in BOTH periods', async () => {
      /**
       * The clause the owner made explicit, and the one a plausible
       * implementation gets wrong in two different directions at once: reaching
       * BACK to decrement the period the qualification was charged to, or
       * reaching FORWARD to credit the period the refund landed in.
       *
       * Shahrivar 1405 ends at 2026-09-22T20:30Z, so these two instants are in
       * different Jalali months while being only weeks apart — and the second
       * is still Gregorian 2026-10, which a Gregorian implementation would also
       * have separated. The assertion below on the period KEY is what
       * distinguishes them: `1405-06`, never `2026-09`.
       */
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));
      const { referrer, orderId } = await awardedReferral();

      const before = await counterRows(referrer.id);
      expect(before).toHaveLength(1);
      // The Solar Hijri key `V32-DEC-035` ratified, asserted here so this test
      // fails loudly if the cap calendar is ever changed underneath it.
      expect(before[0].period).toBe('1405-06');

      // A month later, in Mehr 1405.
      ctx.referralClock.freeze(new Date('2026-10-10T10:00:00.000Z'));
      const result = await refundAndReverse(orderId, ORDER_TOTAL);
      expect(result.reversed).toBe(true);

      const after = await counterRows(referrer.id);
      // The ORIGINAL period is untouched...
      expect(after).toEqual(before);
      // ...and no row was created in the period the refund landed in. A
      // cross-period adjustment would show up as a second row here, which a
      // single-row equality check alone would not have caught.
      expect(after.map((row) => row.period)).toEqual(['1405-06']);
    });

    it('does not free the slot for a NEW qualification — the cycling case', async () => {
      /**
       * The property the decision actually buys, stated as behaviour rather
       * than as a row comparison: after a reversal, the referrer's next
       * qualification consumes the NEXT slot, not the one that was returned.
       *
       * This is the assertion an abuser would have to defeat. The two above
       * prove the row did not move; this proves that the row not moving means
       * what the decision says it means.
       */
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));

      const { referrer, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);

      // The same referrer invites somebody else and it qualifies.
      const secondReferee = await customer();
      await pendingReferral(referrer, secondReferee);
      const secondBooking = uuidv7();
      await paidOrder(secondBooking, secondReferee.id);
      expect((await qualifyFor(secondReferee, secondBooking)).qualified).toBe(true);

      // TWO, not one: the reversed referral's slot was never given back.
      const rows = await counterRows(referrer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].qualified_count).toBe(2);
    });

    it('does not free a slot for a referrer who is already CAPPED', async () => {
      /**
       * The sharpest form of the same property, and the one with money behind
       * it. A referrer at the cap gets `capped` rather than a reward; if a
       * reversal returned a slot, their very next qualification would become
       * payable again — which is the cycling loop, reachable in two events.
       */
      ctx.referralClock.freeze(new Date('2026-09-15T10:00:00.000Z'));

      const referrer = await customer();
      withRewards(50, 30);
      await dataSource.query(
        `INSERT INTO referral.referrer_counters (referrer_user_id, period, qualified_count)
         VALUES ($1, '1405-06', $2)`,
        [referrer.id, REFERRAL_MONTHLY_CAP],
      );

      // One capped qualification, then its order is fully refunded.
      const referee = await customer();
      await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);
      expect((await qualifyFor(referee, bookingId)).referrerOutcome).toBe('capped');

      const before = await counterRows(referrer.id);
      await refundAndReverse(orderId, ORDER_TOTAL);
      expect(await counterRows(referrer.id)).toEqual(before);

      // The next qualification is STILL capped -- the refund bought the
      // referrer nothing.
      const third = await customer();
      await pendingReferral(referrer, third);
      const thirdBooking = uuidv7();
      await paidOrder(thirdBooking, third.id);
      expect((await qualifyFor(third, thirdBooking)).referrerOutcome).toBe('capped');
    });
  });

  // ==========================================================================
  // 7. Balance, lifetime earned, tier and membership
  // ==========================================================================

  describe('the effect on the customer record', () => {
    it('drives the spendable balance NEGATIVE when the points were already spent', async () => {
      // The exploit `V32-DEC-017` closes, in one test: book, get referred,
      // spend the points, refund. A clamp at zero would leave the customer
      // materially better off for having been refunded.
      const { referee, referralId, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });

      // The referee spends them. Written directly because the platform has no
      // redemption route yet -- the ledger's `points` column is signed and has
      // always been, and this is what a redemption row looks like.
      await dataSource.query(
        `INSERT INTO loyalty.points_entries (id, user_id, points, base_points, multiplier_bp, reason)
         VALUES ($1, $2, -30, -30, 10000, $3)`,
        [uuidv7(), referee.id, LOYALTY_REASONS.manualAdjustment],
      );
      expect(await ledger.balance(referee.id)).toBe(0);

      await refundAndReverse(orderId, ORDER_TOTAL);

      expect(await ledger.balance(referee.id)).toBe(-30);
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(1);
    });

    it('does NOT clamp the balance at zero', async () => {
      // Asserted separately from the case above, because "went negative once"
      // and "is never floored" are different claims and a clamp could satisfy
      // the first by accident of ordering.
      const { referee, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });
      await dataSource.query(
        `INSERT INTO loyalty.points_entries (id, user_id, points, base_points, multiplier_bp, reason)
         VALUES ($1, $2, -100, -100, 10000, $3)`,
        [uuidv7(), referee.id, LOYALTY_REASONS.manualAdjustment],
      );

      await refundAndReverse(orderId, ORDER_TOTAL);

      expect(await ledger.balance(referee.id)).toBe(-100);
      expect(await ledger.balance(referee.id)).toBeLessThan(0);
    });

    it('leaves LIFETIME EARNED unchanged', async () => {
      const { referee, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });
      const before = await ledger.lifetimeEarned(referee.id);
      expect(before).toBe(30);

      await refundAndReverse(orderId, ORDER_TOTAL);

      // Not merely "still positive": exactly what it was. `lifetimeEarned()`
      // sums positive rows only, so this holds by the shape of the query --
      // which is why it is asserted rather than assumed.
      expect(await ledger.lifetimeEarned(referee.id)).toBe(before);
    });

    it('does NOT demote a tier, and emits no tier-change event', async () => {
      await dataSource.query(
        `INSERT INTO loyalty.tiers (id, slug, name, threshold_points, sort_order, is_active)
         VALUES ($1, 'bronze', 'bronze', 0, 0, true), ($2, 'silver', 'silver', 25, 1, true)`,
        [uuidv7(), uuidv7()],
      );

      const { referee, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });
      expect(await tiers.currentTierSlug(referee.id)).toBe('silver');

      const crossingsBefore = await dataSource.query(
        'SELECT count(*)::int AS n FROM loyalty.tier_crossings WHERE user_id = $1',
        [referee.id],
      );
      // Counted BEFORE, not asserted at zero: the AWARD legitimately crossed
      // bronze -> silver and emitted one. What must not happen is a SECOND
      // event on the way back down.
      const tierEventsBefore = await dataSource.query(
        "SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'LoyaltyTierChanged'",
      );
      expect(tierEventsBefore[0].n).toBe(1);

      await refundAndReverse(orderId, ORDER_TOTAL);

      // `V32-DEC-017` accepts the consequence knowingly: the referee stays
      // tier-qualified on points they no longer hold.
      expect(await tiers.currentTierSlug(referee.id)).toBe('silver');
      expect(await ledger.balance(referee.id)).toBe(0);
      expect(
        await dataSource.query('SELECT count(*)::int AS n FROM loyalty.tier_crossings WHERE user_id = $1', [
          referee.id,
        ]),
      ).toEqual(crossingsBefore);

      const tierEventsAfter = await dataSource.query(
        "SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'LoyaltyTierChanged'",
      );
      expect(tierEventsAfter).toEqual(tierEventsBefore);
    });

    it('leaves MEMBERSHIP untouched', async () => {
      const { referee, orderId } = await awardedReferral({ referrerPoints: 0, refereePoints: 30 });
      const before = await memberships.forUser(referee.id);

      await refundAndReverse(orderId, ORDER_TOTAL);

      expect(await memberships.forUser(referee.id)).toEqual(before);
    });

    it('emits NO LoyaltyPointsEarned for the negative row', async () => {
      // `analytics` sums `LoyaltyPointsEarned` into `loyalty_points_earned`. A
      // negative one would quietly turn a gross-earnings metric into a net one,
      // and nothing would report it (ADR-038 §6).
      const { orderId } = await awardedReferral({ referrerPoints: 50, refereePoints: 30 });

      const before = await dataSource.query(
        "SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'LoyaltyPointsEarned'",
      );
      expect(before[0].n).toBe(2);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const after = await dataSource.query(
        "SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'LoyaltyPointsEarned'",
      );
      expect(after[0].n).toBe(2);
    });
  });

  // ==========================================================================
  // 8. Atomicity
  // ==========================================================================

  describe('the transaction', () => {
    it('rolls EVERYTHING back when the second side fails', async () => {
      const { referralId, orderId, referrer, referee } = await awardedReferral();
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      const balancesBefore = [await ledger.balance(referrer.id), await ledger.balance(referee.id)];

      /**
       * Fail between the two sides, at a REAL dependency of the real
       * transaction rather than at a fabricated seam.
       *
       * The referrer is processed first, so failing the ledger's SECOND call
       * leaves the referrer's clawback and reversal row already written inside
       * the transaction — one side taken back with the other still standing,
       * which is precisely the state an audit could never explain and the one
       * that must not survive.
       */
      let ledgerCalls = 0;
      const reverseSpy = jest
        .spyOn(ledger, 'reverse')
        .mockImplementation(async (input, manager) => {
          ledgerCalls += 1;
          if (ledgerCalls === 2) throw new Error('forced failure between the two sides');
          // The genuine implementation for the first side, so the rollback has
          // something real to undo.
          return LoyaltyLedgerService.prototype.reverse.call(ledger, input, manager);
        });

      await expect(reverseFor(orderId)).rejects.toThrow(/forced failure/);
      expect(ledgerCalls).toBe(2);

      reverseSpy.mockRestore();

      // Referral state, both loyalty changes, both reversal rows, and the
      // outbox event -- all gone.
      expect((await referralRow(referralId)).status).toBe('qualified');
      expect((await referralRow(referralId)).reversed_at).toBeNull();
      expect(await reversals(referralId)).toHaveLength(0);
      expect((await ledgerRows(referralId)).filter((r) => r.points < 0)).toHaveLength(0);
      expect(await outboxEvents(ReferralReversed.name)).toHaveLength(0);
      expect([await ledger.balance(referrer.id), await ledger.balance(referee.id)]).toEqual(balancesBefore);
    });

    it('writes the outbox event in the SAME transaction as the state', async () => {
      const { referralId, orderId } = await awardedReferral();

      const before = await outboxEvents(ReferralReversed.name);
      expect(before).toHaveLength(0);

      await refundAndReverse(orderId, ORDER_TOTAL);

      const after = await outboxEvents(ReferralReversed.name);
      expect(after).toHaveLength(1);
      expect(after[0].event_version).toBe(1);
      expect(after[0].payload.referralId).toBe(referralId);
    });
  });

  // ==========================================================================
  // 9. Event and notification privacy
  // ==========================================================================

  describe('the ReferralReversed payload', () => {
    it('carries only ids, closed enums, non-negative integers and an instant', async () => {
      const { referrer, referee, referralId, orderId } = await awardedReferral();

      await refundAndReverse(orderId, ORDER_TOTAL);
      const [event] = await outboxEvents(ReferralReversed.name);

      expect(Object.keys(event.payload).sort()).toEqual(
        [
          'refereeOutcome',
          'refereePointsReversed',
          'refereeUserId',
          'referralId',
          'referrerOutcome',
          'referrerPointsReversed',
          'referrerUserId',
          'reversalOrderId',
          'reversedAt',
        ].sort(),
      );

      expect(event.payload.referralId).toBe(referralId);
      expect(event.payload.referrerUserId).toBe(referrer.id);
      expect(event.payload.refereeUserId).toBe(referee.id);
      expect(event.payload.reversalOrderId).toBe(orderId);

      // MAGNITUDES, never negatives -- the mirror of the bound on
      // `ReferralQualified`, and what stops a reward being smuggled through a
      // reversal event.
      expect(event.payload.referrerPointsReversed).toBe(50);
      expect(event.payload.refereePointsReversed).toBe(30);
    });

    it('contains no phone, no code, no name, no prose and no money detail', async () => {
      const { referrer, referee, orderId } = await awardedReferral();
      await dataSource.query('INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3)', [
        uuidv7(),
        referrer.id,
        'ABCDEFGHJK',
      ]);

      await refundAndReverse(orderId, ORDER_TOTAL);
      const [event] = await outboxEvents(ReferralReversed.name);
      const serialised = JSON.stringify(event.payload);

      // Planted positive controls: values that genuinely exist in the database
      // for these two people, so an assertion that cannot fail is ruled out.
      expect(serialised).not.toContain('ABCDEFGHJK');
      expect(serialised).not.toContain(referrer.phone);
      expect(serialised).not.toContain(referee.phone);
      expect(serialised).not.toMatch(/toman|amount|currency|refundId|reason/i);
      // No Persian text of any kind -- the shape prose would take.
      expect(serialised).not.toMatch(/[؀-ۿ]/);
    });
  });

  describe('the notification', () => {
    it('is in-app, under the opt-outable referral category, one per party', async () => {
      const { referrer, referee, referralId, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);
      await relay.drain();

      const referrerNotifications = (await notificationsFor(referrer.id)).filter((n) =>
        n.template_key.startsWith('referral_reversed'),
      );
      const refereeNotifications = (await notificationsFor(referee.id)).filter((n) =>
        n.template_key.startsWith('referral_reversed'),
      );

      expect(referrerNotifications).toHaveLength(1);
      expect(refereeNotifications).toHaveLength(1);

      // Each told about their OWN side, and the template keys differ, so
      // neither can receive the other's message.
      expect(referrerNotifications[0].template_key).toBe('referral_reversed_referrer');
      expect(refereeNotifications[0].template_key).toBe('referral_reversed_referee');

      for (const notification of [...referrerNotifications, ...refereeNotifications]) {
        expect(notification.channel).toBe('in_app');
        expect(notification.category).toBe('referral');
        expect(notification.entity_type).toBe('referral');
        expect(notification.entity_id).toBe(referralId);
        // No variable a figure, a name, a code, or an order id could enter
        // through -- `requiredVars` is empty on both templates.
        expect(notification.payload).toEqual({});
      }
    });

    it('sends NO sms, email or push', async () => {
      const { referrer, referee, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);
      await relay.drain();

      const all = [...(await notificationsFor(referrer.id)), ...(await notificationsFor(referee.id))];
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((n) => n.channel === 'in_app')).toBe(true);
    });

    it('is SUPPRESSED for a party who has opted out of referral notifications', async () => {
      const { referrer, referee, orderId } = await awardedReferral();

      await dataSource.query(
        `INSERT INTO notification.preferences (id, user_id, category, enabled)
         VALUES ($1, $2, 'referral', false)`,
        [uuidv7(), referrer.id],
      );

      await refundAndReverse(orderId, ORDER_TOTAL);
      await relay.drain();

      const referrerReversed = (await notificationsFor(referrer.id)).filter((n) =>
        n.template_key.startsWith('referral_reversed'),
      );
      const refereeReversed = (await notificationsFor(referee.id)).filter((n) =>
        n.template_key.startsWith('referral_reversed'),
      );

      // Suppressed, not failed -- and the other party is unaffected, because
      // the preference is personal.
      expect(referrerReversed.every((n) => n.status === 'suppressed')).toBe(true);
      expect(refereeReversed.some((n) => n.status !== 'suppressed')).toBe(true);
    });

    it('re-notifies nobody on a redelivered event', async () => {
      const { referrer, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);
      await relay.drain();

      const first = (await notificationsFor(referrer.id)).length;

      // Un-publish and drain again -- exactly what an at-least-once relay does.
      await dataSource.query(
        "UPDATE referral.outbox_events SET published_at = NULL WHERE event_type = 'ReferralReversed'",
      );
      await relay.drain();

      expect((await notificationsFor(referrer.id)).length).toBe(first);
    });
  });

  // ==========================================================================
  // 10. Out-of-order delivery
  // ==========================================================================

  describe('out-of-order delivery', () => {
    it('CONVERGES when the full refund is recorded BEFORE qualification is consumed', async () => {
      // The interleaving the relay makes ordinary: two outbox tables, no
      // cross-source ordering, and a failed handler retried on an arbitrarily
      // later sweep. Without the convergence read this ends with an active
      // reward on a fully refunded order -- `V32-DEC-017`'s free-points loop.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      withRewards(50, 30);

      // The refund lands first, and finds a referral that is still pending.
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());
      expect((await reverseFor(orderId)).reversed).toBe(false);
      expect((await referralRow(referralId)).status).toBe('pending');

      // Then the booking completion arrives, through the real handler path.
      await dataSource.transaction(async (manager) => {
        const qualified = await qualification.qualify(manager, {
          refereeUserId: referee.id,
          bookingId,
        });
        expect(qualified.qualified).toBe(true);
        await reversal.reverseAlreadyRefundedBooking(manager, bookingId);
      });

      const row = await referralRow(referralId);
      expect(row.status).toBe('reversed');
      expect(row.reversal_order_id).toBe(orderId);

      // Both events exist, in the order the facts occurred -- a consumer sees a
      // qualification followed by its reversal, not a qualification that
      // silently never happened.
      const events = await outboxEvents();
      expect(events.map((e) => e.event_type)).toEqual(['ReferralQualified', 'ReferralReversed']);

      // And the net effect on both people is zero.
      expect(await ledger.balance(referrer.id)).toBe(0);
      expect(await ledger.balance(referee.id)).toBe(0);
      const rows = await ledgerRows(referralId);
      expect(rows).toHaveLength(4);
      expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(0);
    });

    it('does NOT reverse at qualification time when the order is merely PARTIALLY refunded', async () => {
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      await orders.recordRefund(orderId, ORDER_TOTAL / 2, uuidv7());

      await dataSource.transaction(async (manager) => {
        await qualification.qualify(manager, { refereeUserId: referee.id, bookingId });
        await reversal.reverseAlreadyRefundedBooking(manager, bookingId);
      });

      expect((await referralRow(referralId)).status).toBe('qualified');
    });

    it('does NOT reverse at qualification time when the booking has no order at all', async () => {
      // The overwhelmingly common shape, and the one that must stay cheap and
      // silent: a booking with no commerce order behind it.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();

      await dataSource.transaction(async (manager) => {
        await qualification.qualify(manager, { refereeUserId: referee.id, bookingId });
        await reversal.reverseAlreadyRefundedBooking(manager, bookingId);
      });

      expect((await referralRow(referralId)).status).toBe('qualified');
    });

    it('CONVERGES through the REAL handler chain, driven by the relay', async () => {
      /**
       * The cases above call the two services the way the handler does. This
       * one drives nothing directly: both events go into their real outbox
       * tables and `relay.drain()` dispatches them, so the composition root's
       * wiring, the handler's own `qualified` guard, and the ordering are all
       * under test rather than reproduced.
       *
       * It matters because a mutation probe found the gap: removing the
       * convergence call from the HANDLER left every convergence test green,
       * since they each called the service themselves. A test that reproduces
       * the code it is testing proves the reproduction.
       *
       * `OrderRefunded` is inserted FIRST and `commerce` drains before
       * `booking`, so the refund is genuinely consumed before the booking
       * completion that qualifies the referral.
       */
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);

      // A REAL professional, service and completed booking, not fabricated ids.
      // `BookingCompleted` has other consumers -- `review_eligibility` among
      // them -- and they hold foreign keys into `provider`. A fixture that
      // satisfies only the referral handler is a fixture that never reaches it.
      const proOwner = await customer();
      const professional = await seedProfessional(dataSource, proOwner.id, 'متخصص');
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(-24));
      const bookingId = uuidv7();
      await dataSource.query(
        `INSERT INTO booking.bookings
           (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          bookingId,
          referee.id,
          professional.id,
          professional.serviceId,
          slotId,
          futureSlotTime(-24),
          futureSlotTime(-23),
        ],
      );
      const orderId = await paidOrder(bookingId, referee.id);

      withRewards(50, 30);

      // A real refund, through commerce, which writes the real OrderRefunded.
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      await dataSource.query(
        `INSERT INTO booking.outbox_events
           (id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'booking', $2, 'BookingCompleted', 1, $3::jsonb)`,
        [
          uuidv7(),
          bookingId,
          JSON.stringify({
            bookingId,
            professionalId: professional.id,
            customerId: referee.id,
            serviceId: professional.serviceId,
            completedAt: new Date().toISOString(),
          }),
        ],
      );

      // Twice: the second drain dispatches the ReferralQualified and
      // ReferralReversed rows the first one produced, so the notifications land
      // too and redelivery is exercised on the way.
      await relay.drain();
      await relay.drain();

      // Every `BookingCompleted` handler must have succeeded, not just the
      // referral one. The relay aborts an envelope's handler loop on the first
      // throw and leaves the row unpublished, so a partially-dispatched event
      // would make everything below a test of the wrong thing -- which is
      // exactly what happened on the first run of this case, where a
      // `review_eligibility` foreign key rejected a fabricated professional id
      // and the referral handler was never reached.
      const bookingOutbox = await dataSource.query(
        'SELECT published_at, attempts, last_error FROM booking.outbox_events',
      );
      expect(bookingOutbox).toEqual([
        expect.objectContaining({ attempts: 0, last_error: null }),
      ]);
      expect(bookingOutbox[0].published_at).not.toBeNull();

      const row = await referralRow(referralId);
      expect(row.status).toBe('reversed');
      expect(row.reversal_order_id).toBe(orderId);

      expect((await outboxEvents()).map((e) => e.event_type)).toEqual([
        'ReferralQualified',
        'ReferralReversed',
      ]);

      // The REFERRAL's own four rows net to zero -- the qualification really
      // happened and was really reversed, rather than never happening.
      const referralLedger = await ledgerRows(referralId);
      expect(referralLedger).toHaveLength(4);
      expect(referralLedger.reduce((sum, r) => sum + r.points, 0)).toBe(0);

      // The referrer has nothing else, so their balance is exactly zero.
      expect(await ledger.balance(referrer.id)).toBe(0);

      // The referee keeps their OWN booking-completion points, which
      // `BookingCompletedLoyaltyHandler` awarded in the same drain and which
      // this story must not touch: it is a separate fact with a separate
      // idempotency key, and a clawback that reached it would be taking back a
      // reward the customer genuinely earned by turning up.
      const bookingPoints = (await dataSource.query(
        `SELECT COALESCE(SUM(points), 0)::int AS total FROM loyalty.points_entries
          WHERE user_id = $1 AND reason = $2`,
        [referee.id, LOYALTY_REASONS.bookingCompleted],
      )) as Array<{ total: number }>;
      expect(bookingPoints[0].total).toBeGreaterThan(0);
      expect(await ledger.balance(referee.id)).toBe(bookingPoints[0].total);

      // And both parties were told, about their own side only.
      expect((await notificationsFor(referrer.id)).map((n) => n.template_key).sort()).toEqual([
        'referral_qualified_referrer',
        'referral_reversed_referrer',
      ]);
      expect((await notificationsFor(referee.id)).map((n) => n.template_key).sort()).toEqual([
        'referral_qualified_referee',
        'referral_reversed_referee',
      ]);
    });

    it('reverses exactly ONCE when both paths race', async () => {
      // Both directions attempted concurrently against the same referral. Only
      // one may win, and the loser must write nothing.
      const referrer = await customer();
      const referee = await customer();
      const referralId = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      const orderId = await paidOrder(bookingId, referee.id);

      withRewards(50, 30);
      await orders.recordRefund(orderId, ORDER_TOTAL, uuidv7());

      await dataSource.transaction(async (manager) => {
        await qualification.qualify(manager, { refereeUserId: referee.id, bookingId });
        await reversal.reverseAlreadyRefundedBooking(manager, bookingId);
      });

      const results = await Promise.all([reverseFor(orderId), reverseFor(orderId)]);
      expect(results.filter((r) => r.reversed)).toHaveLength(0);

      expect(await reversals(referralId)).toHaveLength(2);
      expect(await outboxEvents(ReferralReversed.name)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 11. Privacy: subject-data coverage, export and erasure
  // ==========================================================================

  describe('privacy', () => {
    const contractsOf = () => app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
    const referralContract = () => contractsOf().find((c) => c.moduleKey === 'referral')!;

    /**
     * The REAL `referral` schema, read from `information_schema`.
     *
     * Not a hand-written list: the whole point of ADR-027's check is that it
     * compares claims against what the database actually contains, and a
     * fixture catalogue would be asserting against a second set of claims.
     */
    const realReferralCatalogue = async () =>
      (await app.get(SubjectDataCoverageService).readCatalogue()).filter((t) => t.schema === 'referral');

    it('claims the new table as RETAINED, with a reason', async () => {
      const claim = referralContract().tables.find((t) => t.table === 'referral.reward_reversals');
      expect(claim?.disposition).toBe('retained');
      // `retained` is the disposition that EXCUSES a table from erasure, so it
      // is the one that must justify itself.
      expect(claim?.reason).toBeTruthy();
    });

    it('is NON-VACUOUS: an UNCLAIMED new table fails coverage', async () => {
      // ADR-027's `no_claim` violation. Asserted rather than assumed, because a
      // coverage check that cannot fail proves nothing — and this is the exact
      // failure that would have shipped had the contract not changed in the
      // same commit as the migration.
      const stripped: SubjectDataContract[] = contractsOf().map((contract) =>
        contract.moduleKey === 'referral'
          ? {
              ...contract,
              tables: contract.tables.filter((claim) => claim.table !== 'referral.reward_reversals'),
            }
          : contract,
      );

      const result = evaluateCoverage(await realReferralCatalogue(), stripped);
      expect(JSON.stringify(result.violations)).toContain('reward_reversals');
    });

    it('is NON-VACUOUS: a STALE claim for a table that does not exist fails coverage', async () => {
      // The converse violation, `claimed_but_absent`, which ADR-027 treats as
      // worse than no claim at all because it reads as coverage.
      const stale: SubjectDataContract[] = contractsOf().map((contract) =>
        contract.moduleKey === 'referral'
          ? {
              ...contract,
              tables: [
                ...contract.tables,
                { table: 'referral.reward_reversals_old', disposition: 'retained' as const, reason: 'stale' },
              ],
            }
          : contract,
      );

      const result = evaluateCoverage(await realReferralCatalogue(), stale);
      expect(JSON.stringify(result.violations)).toContain('reward_reversals_old');
    });

    it('is NON-VACUOUS: a FALSE no_subject_data claim fails coverage', async () => {
      // `recipient_user_id` carries the `_user_id` suffix, so ADR-027's
      // heuristic rejects the claim on the strength of the column name alone —
      // which is the belt under the braces of the declared disposition.
      const lying: SubjectDataContract[] = contractsOf().map((contract) =>
        contract.moduleKey === 'referral'
          ? {
              ...contract,
              tables: contract.tables.map((claim) =>
                claim.table === 'referral.reward_reversals'
                  ? { table: claim.table, disposition: 'no_subject_data' as const, reason: 'untrue' }
                  : claim,
              ),
            }
          : contract,
      );

      const result = evaluateCoverage(await realReferralCatalogue(), lying);
      expect(JSON.stringify(result.violations)).toContain('reward_reversals');
    });

    it('exports the subject their OWN reversals, and never the counterparty', async () => {
      const { referrer, referee, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);

      const referralModule = app.get(ReferralSubjectDataContract);

      for (const [subject, other] of [
        [referrer, referee],
        [referee, referrer],
      ] as const) {
        const sections = await dataSource.transaction((manager) =>
          referralModule.exportSubjectData(manager, subject.id),
        );
        const reversalSection = sections.find((s) => s.key === 'referral_reward_reversals');
        expect(reversalSection).toBeDefined();
        expect(reversalSection?.rows).toHaveLength(1);

        const row = reversalSection?.rows[0] as Record<string, unknown>;
        expect(Object.keys(row).sort()).toEqual(['outcome', 'points', 'reversedAt', 'side']);

        // Planted positive controls: the counterparty's real identifiers.
        const serialised = JSON.stringify(sections);
        expect(serialised).not.toContain(other.id);
        expect(serialised).not.toContain(other.phone);
      }
    });

    it('reports the reversals as RETAINED on erasure, with a truthful count', async () => {
      const { referee, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);

      const referralModule = app.get(ReferralSubjectDataContract);

      const outcome = await dataSource.transaction((manager) =>
        referralModule.eraseSubjectData(manager, referee.id, tombstoneFor(referee.id, new Date())),
      );

      expect(outcome.retained.map((r) => r.table)).toContain('referral.reward_reversals');

      // Retained means retained: the row is still there afterwards.
      const [{ n }] = await dataSource.query(
        'SELECT count(*)::int AS n FROM referral.reward_reversals WHERE recipient_user_id = $1',
        [referee.id],
      );
      expect(n).toBe(1);
    });
  });

  // ==========================================================================
  // 12. Database invariants, proved by RAW SQL that bypasses every service
  // ==========================================================================

  describe('the database refuses what the application must never write', () => {
    async function qualifiedReferral(): Promise<{ id: string; bookingId: string }> {
      const referrer = await customer();
      const referee = await customer();
      const id = await pendingReferral(referrer, referee);
      const bookingId = uuidv7();
      await qualifyFor(referee, bookingId);
      return { id, bookingId };
    }

    it('refuses TORN reversal facts — a status with no cause', async () => {
      const { id } = await qualifiedReferral();
      await expect(
        dataSource.query("UPDATE referral.referrals SET status = 'reversed' WHERE id = $1", [id]),
      ).rejects.toThrow(/ck_referrals_reversal_complete/);
    });

    it('refuses TORN reversal facts — a cause with no status', async () => {
      const { id } = await qualifiedReferral();
      await expect(
        dataSource.query('UPDATE referral.referrals SET reversed_at = now(), reversal_order_id = $2 WHERE id = $1', [
          id,
          uuidv7(),
        ]),
      ).rejects.toThrow(/ck_referrals_reversal_complete/);
    });

    it('refuses a reversal that precedes its qualification', async () => {
      const { id } = await qualifiedReferral();
      await expect(
        dataSource.query(
          `UPDATE referral.referrals
              SET status = 'reversed', reversed_at = qualified_at - interval '1 second', reversal_order_id = $2
            WHERE id = $1`,
          [id, uuidv7()],
        ),
      ).rejects.toThrow(/ck_referrals_reversed_after_qualified/);
    });

    it('refuses reversed -> qualified, which every CHECK would otherwise allow', async () => {
      // Moving the status back requires clearing the reversal columns --
      // `ck_referrals_reversal_complete` forbids a non-reversed row from
      // carrying them -- and the cleared row then satisfies all three CHECKs
      // at once, which is why this needs the trigger at all.
      //
      // TWO of the trigger's branches refuse it and the IMMUTABILITY one fires
      // first, because nulling `reversed_at` is itself a rewrite of a recorded
      // fact. That ordering is asserted rather than glossed: a future author
      // who reorders the branches should see this test say which one speaks,
      // not merely that something did.
      const { id } = await qualifiedReferral();
      await dataSource.query(
        `UPDATE referral.referrals SET status = 'reversed', reversed_at = now(), reversal_order_id = $2 WHERE id = $1`,
        [id, uuidv7()],
      );

      await expect(
        dataSource.query(
          `UPDATE referral.referrals
              SET status = 'qualified', reversed_at = NULL, reversal_order_id = NULL
            WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/reversal is immutable|status transition/i);

      expect((await referralRow(id)).status).toBe('reversed');
    });

    it('refuses pending -> reversed, which ONLY the transition guard catches', async () => {
      // The case that makes the transition allow-list load-bearing rather than
      // decorative. Setting all four columns at once satisfies
      // `ck_referrals_qualification_complete` (the qualification facts are
      // present), `ck_referrals_reversal_complete` (so are the reversal facts),
      // and both immutability branches (OLD had NULL in every one of them) --
      // so nothing but the allow-list stands between this statement and a
      // referral that was reversed without ever having been qualified.
      const referrer = await customer();
      const referee = await customer();
      const id = await pendingReferral(referrer, referee);

      await expect(
        dataSource.query(
          `UPDATE referral.referrals
              SET status = 'reversed', qualified_at = now(), qualifying_booking_id = $2,
                  reversed_at = now(), reversal_order_id = $3
            WHERE id = $1`,
          [id, uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/status transition/i);

      expect((await referralRow(id)).status).toBe('pending');
    });

    it('refuses REWRITING the reversal facts once recorded', async () => {
      const { id } = await qualifiedReferral();
      await dataSource.query(
        `UPDATE referral.referrals SET status = 'reversed', reversed_at = now(), reversal_order_id = $2 WHERE id = $1`,
        [id, uuidv7()],
      );

      await expect(
        dataSource.query('UPDATE referral.referrals SET reversal_order_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/reversal is immutable/);
    });

    it('still refuses rewriting the ATTRIBUTION and the QUALIFICATION facts', async () => {
      // The trigger was replaced by this migration; the two rules it already
      // enforced must still hold. A `CREATE OR REPLACE` that dropped a branch
      // would pass every new test and silently unfreeze the old columns.
      const { id } = await qualifiedReferral();
      await expect(
        dataSource.query('UPDATE referral.referrals SET referrer_user_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/attribution is immutable/);
      await expect(
        dataSource.query('UPDATE referral.referrals SET qualifying_booking_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/qualification is immutable/);
    });

    it('refuses a SECOND reversal row for the same referral and side', async () => {
      const { referralId, orderId } = await awardedReferral();
      await refundAndReverse(orderId, ORDER_TOTAL);

      await expect(
        dataSource.query(
          `INSERT INTO referral.reward_reversals
             (id, referral_id, recipient_user_id, side, outcome, points, ledger_reason, reversed_at)
           VALUES ($1, $2, $3, 'referrer', 'reversed', 50, $4, now())`,
          [uuidv7(), referralId, uuidv7(), LOYALTY_REASONS.referralReferrerReversal],
        ),
      ).rejects.toThrow(/uq_reward_reversals_referral_side/);
    });

    it('refuses an outcome that disagrees with its amount', async () => {
      const { referralId } = await awardedReferral();
      await expect(
        dataSource.query(
          `INSERT INTO referral.reward_reversals
             (id, referral_id, recipient_user_id, side, outcome, points, ledger_reason, reversed_at)
           VALUES ($1, $2, $3, 'referrer', 'nothing_to_reverse', 50, $4, now())`,
          [uuidv7(), referralId, uuidv7(), LOYALTY_REASONS.referralReferrerReversal],
        ),
      ).rejects.toThrow(/ck_reward_reversals_outcome_matches_points/);
    });

    it('refuses a zero-point `reversed` row — the honest zero, enforced', async () => {
      const { referralId } = await awardedReferral();
      await expect(
        dataSource.query(
          `INSERT INTO referral.reward_reversals
             (id, referral_id, recipient_user_id, side, outcome, points, ledger_reason, reversed_at)
           VALUES ($1, $2, $3, 'referee', 'reversed', 0, $4, now())`,
          [uuidv7(), referralId, uuidv7(), LOYALTY_REASONS.referralRefereeReversal],
        ),
      ).rejects.toThrow(/ck_reward_reversals_outcome_matches_points/);
    });

    it('refuses a negative amount on a reversal row', async () => {
      // The direction is carried by the table's name and by the ledger row's
      // reason; a signed column here would let a reversal row assert a reward.
      //
      // `ck_reward_reversals_outcome_matches_points` catches this first, which
      // means `ck_reward_reversals_points_non_negative` is a redundant floor
      // rather than the active guard for any value the two outcomes admit. It
      // is kept deliberately — if a third outcome is ever added, the floor is
      // what stops a negative slipping in with it — and the assertion names the
      // family rather than pretending to know which one speaks.
      const { referralId } = await awardedReferral();
      await expect(
        dataSource.query(
          `INSERT INTO referral.reward_reversals
             (id, referral_id, recipient_user_id, side, outcome, points, ledger_reason, reversed_at)
           VALUES ($1, $2, $3, 'referee', 'reversed', -30, $4, now())`,
          [uuidv7(), referralId, uuidv7(), LOYALTY_REASONS.referralRefereeReversal],
        ),
      ).rejects.toThrow(/ck_reward_reversals_(points_non_negative|outcome_matches_points)/);
    });
  });
});
