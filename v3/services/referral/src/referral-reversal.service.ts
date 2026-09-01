import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { returningRows } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ReferralReversed,
  emitContractEvent,
} from '@beauclick/event-contracts';
import type { ReferralReversalOutcome, ReferralRewardSide } from '@beauclick/event-contracts';

import {
  ReferralOutboxEntity,
  ReferralRewardGrantEntity,
  ReferralRewardReversalEntity,
} from './entities/referral.entities';
import { REFERRAL_CLOCK, ReferralClock } from './referral-clock';
import {
  REFERRAL_LOYALTY_REVERSAL_PORT,
  ReferralLoyaltyReversalPort,
  ReferralReversalLedgerReason,
  ReferralRewardLedgerReason,
} from './ports/referral-loyalty-reversal.port';
import {
  REFERRAL_ORDER_LOOKUP_PORT,
  ReferralOrderLookupPort,
} from './ports/referral-order-lookup.port';
/**
 * The ledger reference type, imported rather than redeclared.
 *
 * The reversal shares its reference with the award it reverses —
 * `('referral', <referral id>)`, never the booking and never the order — which
 * is what makes the two rows findable as one account of what a referral did to
 * a balance. A second local copy of the string would be a second idempotency
 * namespace waiting to happen.
 *
 * This is the only thing this service takes from the qualification one, and the
 * dependency runs in this direction only: qualification knows nothing about
 * reversal, and the convergence path (ADR-038 §8) is composed by the handler
 * rather than by one service calling the other.
 */
import { REFERRAL_LEDGER_REFERENCE_TYPE } from './referral-qualification.service';

/**
 * The reversal reason each side's clawback is written under (`V32-DEC-017`).
 *
 * Two, never one, for the same reason there are two reward reasons: the
 * ledger's idempotency is `UNIQUE(reference_type, reference_id, reason)`, and
 * one reason cannot idempotently claw back from two people against one referral
 * id.
 */
const REVERSAL_REASON_BY_SIDE: Record<ReferralRewardSide, ReferralReversalLedgerReason> = {
  referrer: 'referral_referrer_reversal',
  referee: 'referral_referee_reversal',
};

/** The reward reason each side's original award was written under. */
const REWARD_REASON_BY_SIDE: Record<ReferralRewardSide, ReferralRewardLedgerReason> = {
  referrer: 'referral_referrer_reward',
  referee: 'referral_referee_reward',
};

/** Both sides, always both, referrer first — the order `ReferralReversed` reports them in. */
const SIDES: readonly ReferralRewardSide[] = ['referrer', 'referee'];

export interface ReversalResult {
  readonly reversed: boolean;
  readonly referralId: string | null;
  readonly referrerOutcome: ReferralReversalOutcome | null;
  readonly refereeOutcome: ReferralReversalOutcome | null;
}

const NOT_REVERSED: ReversalResult = {
  reversed: false,
  referralId: null,
  referrerOutcome: null,
  refereeOutcome: null,
};

/** What one side's processing decided, before anything is written. */
interface SideReversal {
  readonly side: ReferralRewardSide;
  readonly recipientUserId: string;
  readonly outcome: ReferralReversalOutcome;
  readonly points: number;
}

/**
 * Referral reversal and the loyalty clawback — V3.2-C Story #28 (ADR-038).
 *
 * ## Payment is the reversal authority, and booking stays the qualification one
 *
 * `V32-DEC-018` puts it in one sentence: *"Booking is the qualification
 * authority; payment is the reversal authority only."* This service is the
 * second clause. It never qualifies anything, never reads a booking, and has no
 * route into it that is not a **full refund the platform has already recorded**
 * — there is no public endpoint, no administrative endpoint, and no manual
 * reversal path, all three of which `V32-DEC-019` refuses.
 *
 * ## Two entry points, one core, and the second is not a special case
 *
 * `reverseForRefundedOrder` is the ordinary path: `OrderRefunded` arrives, the
 * order is re-read, and a qualified referral against its booking is reversed.
 *
 * `reverseAlreadyRefundedBooking` is the **convergence** path (ADR-038 §8), and
 * it exists because the relay makes refund-before-qualification ordinary rather
 * than exotic: outbox sources drain independently with no cross-source
 * ordering, and a handler that throws leaves its row for an arbitrarily later
 * sweep. Without it, a refund consumed before its `BookingCompleted` would find
 * a `pending` referral, no-op, and leave an active reward standing on a fully
 * refunded order — `V32-DEC-017`'s free-points loop, reintroduced by delivery
 * order alone.
 *
 * Both funnel into the same `reverse` below, so there is exactly one
 * implementation of what a reversal *is*. The difference between them is only
 * how the order was established as fully refunded.
 *
 * ## What makes it replay-safe
 *
 * The compare-and-swap predicate `status = 'qualified'`, and nothing before it.
 * A redelivered `OrderRefunded`, a referral still pending, one already
 * reversed, and a refund for an order no referral concerns all cost exactly one
 * `UPDATE` affecting zero rows and write nothing at all.
 *
 * The affected-row count is read through `returningRows`, **never
 * `result.length`**, for the reason `sql-result.ts` records: TypeORM's postgres
 * driver returns `[rows, rowCount]` for `UPDATE` *even with `RETURNING`*, so
 * `result.length` is always 2 and a guard reading it never fires. That mistake
 * has shipped twice here, once letting a revoked refresh token mint a session.
 *
 * The ledger's `UNIQUE(reference_type, reference_id, reason)` on the two
 * reversal reasons, and `uq_reward_reversals_referral_side`, are two further
 * independent guards — either would refuse a second clawback even if the CAS
 * were removed, which is exactly what the mutation probes check.
 */
@Injectable()
export class ReferralReversalService {
  private readonly logger = new Logger('ReferralReversalService');

  constructor(
    @Inject(REFERRAL_CLOCK) private readonly clock: ReferralClock,
    @Inject(REFERRAL_ORDER_LOOKUP_PORT) private readonly orders: ReferralOrderLookupPort,
    @Inject(REFERRAL_LOYALTY_REVERSAL_PORT) private readonly loyalty: ReferralLoyaltyReversalPort,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  /**
   * Reverses the referral a fully refunded order qualified, if there is one.
   *
   * Called by the `OrderRefunded` handler with that event's order id — the only
   * usable field it carries.
   *
   * ## Three refusals, in the order they cost the least to make
   *
   * **The order must exist.** `null` is not an error: a refund for an order this
   * process cannot see is nothing this domain can act on, and raising would
   * poison the outbox row into retrying forever.
   *
   * **The refund must be FULL, and that is read from the order.** `V32-DEC-017`
   * reverses only on a full refund, and the event cannot tell full from
   * partial: `recordRefund` emits the same event for both, and a sequence of
   * partials eventually produces a full refund whose final event looks exactly
   * like the ones that did not. `fullyRefunded` comes from the order's
   * authoritative status, which the database computed in the same statement
   * that moved the money.
   *
   * **The order must be a BOOKING order.** `commerce.orders.source_type` admits
   * `booking` and `direct`; only the first can have qualified a referral
   * (`V32-DEC-018`), and a `direct` order's `source_id` is not a booking id at
   * all — matching it against `qualifying_booking_id` would be comparing two
   * different namespaces and hoping they never collide.
   *
   * ## `duplicate_charge` needs no refusal here, and that is stronger than one
   *
   * `RefundCompletedCommerceHandler` returns before calling `recordRefund` when
   * the refund kind is a duplicate charge, and that handler is `recordRefund`'s
   * only production caller. So a duplicate charge never increments the order's
   * refunded total, never moves its status, and **never produces an
   * `OrderRefunded` event at all**. There is nothing to branch on because the
   * event does not arrive; adding a check would be a guard that can never fire,
   * which reads to the next author as though the danger were being handled
   * somewhere (ADR-038 §3).
   */
  async reverseForRefundedOrder(manager: EntityManager, orderId: string): Promise<ReversalResult> {
    const order = await this.orders.findOrderById(manager, orderId);
    if (!order) return NOT_REVERSED;
    if (!order.fullyRefunded) return NOT_REVERSED;
    if (order.sourceType !== 'booking') return NOT_REVERSED;

    return this.reverse(manager, { bookingId: order.sourceId, orderId: order.orderId });
  }

  /**
   * Reverses a referral whose qualifying booking already belongs to a fully
   * refunded order — the convergence path (ADR-038 §8).
   *
   * Called by `ReferralQualificationService` **inside the qualification
   * transaction**, immediately after the qualification compare-and-swap wins.
   * Returns `reversed: false` in the overwhelmingly common case where the
   * booking has no order, or has one that is not fully refunded.
   *
   * The `FOR SHARE` lock the port takes on the order row is what makes this
   * sufficient rather than merely usually-right. Without it there is a window —
   * refund commits after the qualification's read but before its commit, with
   * the reversal handler's CAS landing in between and seeing a `pending` row —
   * in which both paths miss. With it, either the qualification locks first and
   * the refund waits (so the reversal handler runs afterwards and finds a
   * qualified referral), or the refund commits first and this read sees it.
   *
   * No deadlock is possible: the refund path never touches
   * `referral.referrals`, so there is no cycle to close.
   */
  async reverseAlreadyRefundedBooking(
    manager: EntityManager,
    bookingId: string,
  ): Promise<ReversalResult> {
    const order = await this.orders.findBookingOrder(manager, bookingId);
    if (!order) return NOT_REVERSED;
    if (!order.fullyRefunded) return NOT_REVERSED;

    return this.reverse(manager, { bookingId, orderId: order.orderId });
  }

  /**
   * The reversal itself: one compare-and-swap, both sides, one event, all in
   * the caller's transaction.
   *
   * The order below is the design, in the same way the qualification's is:
   *
   *  1. **The compare-and-swap first**, because it is the only guard and
   *     everything after it lives in its success branch.
   *  2. **Both sides**, always both, decided from their persisted grants.
   *  3. **The ledger clawback**, only for a side that actually received one.
   *  4. **The reversal rows**, whatever each side's outcome was.
   *  5. **The event last**, so its payload states outcomes already durable in
   *     the same transaction.
   */
  private async reverse(
    manager: EntityManager,
    input: { bookingId: string; orderId: string },
  ): Promise<ReversalResult> {
    const now = this.clock.now();

    // -----------------------------------------------------------------------
    // 1. The compare-and-swap. The only guard, and the first write.
    // -----------------------------------------------------------------------
    //
    // Addressed by the QUALIFYING BOOKING, which is the only handle a refund
    // gives us. At most one row can match: a booking has one customer, and
    // `uq_referrals_referee` gives a customer at most one referral -- so this
    // is a single-row update by construction rather than by a LIMIT.
    //
    // `status = 'qualified'` is strict. A pending referral is not reversible
    // (there is no reward to take back), and a reversed one is terminal --
    // `tg_referrals_immutable` refuses the transition back besides.
    //
    // The status, the instant and the causing order are set by THIS ONE
    // STATEMENT. `ck_referrals_reversal_complete` requires all three to move
    // together, so a crash between "marked reversed" and "recorded which order"
    // is unrepresentable -- which is the state that would leave a negative
    // loyalty balance nobody could explain.
    const raw = await manager.query(
      `UPDATE referral.referrals
          SET status = 'reversed',
              reversed_at = $2,
              reversal_order_id = $3
        WHERE qualifying_booking_id = $1
          AND status = 'qualified'
      RETURNING id, referrer_user_id, referee_user_id`,
      [input.bookingId, now, input.orderId],
    );

    // `returningRows`, NEVER `raw.length`. See the class docblock.
    const won = returningRows<{
      id: string;
      referrer_user_id: string;
      referee_user_id: string;
    }>(raw);
    if (won.length === 0) return NOT_REVERSED;

    const referralId = won[0].id;
    const recipients: Record<ReferralRewardSide, string> = {
      referrer: won[0].referrer_user_id,
      referee: won[0].referee_user_id,
    };

    // -----------------------------------------------------------------------
    // 2-4. Both sides, independently.
    // -----------------------------------------------------------------------
    const outcomes = {} as Record<ReferralRewardSide, SideReversal>;
    for (const side of SIDES) {
      const decision = await this.reverseSide(manager, referralId, side, recipients[side]);
      await this.recordReversal(manager, referralId, decision, now);
      outcomes[side] = decision;
    }

    // -----------------------------------------------------------------------
    // 5. The event, last and inside the transaction.
    // -----------------------------------------------------------------------
    //
    // Written to the outbox rather than published, so a rollback takes it with
    // everything else -- and no consumer can observe a reversal the ledger does
    // not reflect.
    await emitContractEvent(this.contracts, manager, ReferralOutboxEntity, ReferralReversed, {
      aggregateId: referralId,
      payload: {
        referralId,
        referrerUserId: recipients.referrer,
        refereeUserId: recipients.referee,
        reversalOrderId: input.orderId,
        reversedAt: now.toISOString(),
        referrerOutcome: outcomes.referrer.outcome,
        referrerPointsReversed: outcomes.referrer.points,
        refereeOutcome: outcomes.referee.outcome,
        refereePointsReversed: outcomes.referee.points,
      },
    });

    // Ids and closed enums. No code, no phone, no name, no points figure and no
    // order metadata -- `V32-DEC-033` keeps referral material out of log lines,
    // and the way to keep it out is not to pass it.
    this.logger.log(
      `referral ${referralId} reversed (referrer ${outcomes.referrer.outcome}, referee ${outcomes.referee.outcome})`,
    );

    return {
      reversed: true,
      referralId,
      referrerOutcome: outcomes.referrer.outcome,
      refereeOutcome: outcomes.referee.outcome,
    };
  }

  /**
   * Decides and applies one side's clawback.
   *
   * ## The grant decides WHETHER; the ledger decides HOW MUCH
   *
   * This split is ADR-038 §5 and it is the correctness of the whole story.
   *
   * Only the **grant** can say whether a side should reverse at all: the ledger
   * cannot distinguish `disabled_zero` from `capped`, because both wrote
   * nothing and both leave the same absence behind. And only the **ledger** can
   * say by how much: `reward_grants.points` is the CONFIGURED BASE, while
   * `award()` credits `Math.round(base * multiplierBp / 10000)` using the
   * recipient's membership benefit at award time. Reversing the grant's figure
   * would under-claw exactly those customers whose tier earned them a bonus, by
   * an amount that grows with the benefit and that nothing would ever report.
   *
   * Neither source is *current configuration*, which is the property
   * `V32-DEC-017` actually protects: the business may raise a reward from 0 to
   * 50 in the months between a booking and its refund, and a customer must
   * never have more taken back than they were given.
   *
   * The two are **cross-checked rather than trusted**: `expectedBasePoints`
   * carries the grant's figure across, and the ledger throws if the original
   * entry's base disagrees. A silent mismatch would mean the grant no longer
   * explains the row it exists to explain.
   *
   * ## A side with nothing to reverse calls the ledger NOT AT ALL
   *
   * `V32-DEC-016`'s honest zero, in the other direction. A zero-value negative
   * row would occupy `('referral', <id>, referral_*_reversal)` permanently, and
   * a figure the business later approved — awarded and then genuinely reversed
   * — would be silently deduplicated away. The bug would surface as "we
   * refunded the order and the points are still there", long after the code
   * that caused it shipped.
   */
  private async reverseSide(
    manager: EntityManager,
    referralId: string,
    side: ReferralRewardSide,
    recipientUserId: string,
  ): Promise<SideReversal> {
    const grant = await manager.getRepository(ReferralRewardGrantEntity).findOne({
      where: { referralId, side },
    });

    // A qualified referral always has both grants -- the qualification writes
    // them in the same transaction as the status. Finding none means the row
    // was hand-written, and the honest response is to record that nothing was
    // taken back rather than to invent an amount or to poison the outbox row
    // by raising. The id is logged; nothing else about the person is.
    if (!grant) {
      this.logger.warn(`referral ${referralId} has no ${side} grant to reverse`);
      return { side, recipientUserId, outcome: 'nothing_to_reverse', points: 0 };
    }

    if (grant.outcome !== 'awarded') {
      return { side, recipientUserId, outcome: 'nothing_to_reverse', points: 0 };
    }

    const { reversed, points } = await this.loyalty.reverse(manager, {
      referenceType: REFERRAL_LEDGER_REFERENCE_TYPE,
      referenceId: referralId,
      originalReason: REWARD_REASON_BY_SIDE[side],
      reversalReason: REVERSAL_REASON_BY_SIDE[side],
      expectedBasePoints: grant.points,
    });

    // `reversed: false` here means the ledger found no original row, or found
    // this reversal already recorded. Both are ordinary, and both mean nothing
    // moved -- so the audit row says so rather than claiming a clawback that
    // did not happen.
    return {
      side,
      recipientUserId,
      outcome: reversed ? 'reversed' : 'nothing_to_reverse',
      points: reversed ? points : 0,
    };
  }

  /**
   * Records one side's reversal. Always written, whatever the outcome.
   *
   * The mirror of `recordGrant`, and for the same reason `V32-DEC-016` gives
   * for writing a `disabled_zero` grant: a row stating that the platform
   * considered this side and found nothing to take back is a materially
   * different claim from no row at all. It is also what makes *"reverse both
   * sides"* impossible to read as *"write two zero-point ledger rows"*.
   */
  private async recordReversal(
    manager: EntityManager,
    referralId: string,
    decision: SideReversal,
    now: Date,
  ): Promise<void> {
    await manager.getRepository(ReferralRewardReversalEntity).insert({
      id: uuidv7(),
      referralId,
      recipientUserId: decision.recipientUserId,
      side: decision.side,
      outcome: decision.outcome,
      points: decision.points,
      ledgerReason: REVERSAL_REASON_BY_SIDE[decision.side],
      reversedAt: now,
    });
  }
}
