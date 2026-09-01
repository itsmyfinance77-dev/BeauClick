import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { affectedAny, returningRows } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ReferralQualified,
  emitContractEvent,
} from '@beauclick/event-contracts';
import type { ReferralRewardOutcome, ReferralRewardSide } from '@beauclick/event-contracts';

import {
  ReferralAttributionEntity,
  ReferralOutboxEntity,
  ReferralRewardGrantEntity,
} from './entities/referral.entities';
import { REFERRAL_CLOCK, ReferralClock, tehranCalendarMonth } from './referral-clock';
import {
  REFERRAL_LOYALTY_PORT,
  ReferralLedgerReason,
  ReferralLoyaltyPort,
} from './ports/referral-loyalty.port';
import { REFERRAL_REWARD_CONFIG, ReferralRewardConfig } from './referral-reward.config';

/**
 * The per-referrer monthly cap — `V32-DEC-019`.
 *
 * **10 qualified referrals per referrer per Tehran calendar month. No lifetime
 * cap.** A module constant rather than a configurable, deliberately: the reward
 * *values* are configuration because `V32-DEC-016` expects the business to set
 * them, but the *cap* is an abuse control the same decision fixes at a number.
 * Making it an environment variable would let a deployment quietly widen an
 * abuse bound that an owner decision closed.
 */
export const REFERRAL_MONTHLY_CAP = 10;

/** The ledger reference type both sides use. The id is the REFERRAL id, never the booking id. */
export const REFERRAL_LEDGER_REFERENCE_TYPE = 'referral';

const LEDGER_REASON_BY_SIDE: Record<ReferralRewardSide, ReferralLedgerReason> = {
  referrer: 'referral_referrer_reward',
  referee: 'referral_referee_reward',
};

/** What one side's processing decided, before anything is written. */
interface SideDecision {
  readonly side: ReferralRewardSide;
  readonly recipientUserId: string;
  readonly outcome: ReferralRewardOutcome;
  readonly points: number;
}

export interface QualificationResult {
  readonly qualified: boolean;
  readonly referralId: string | null;
  readonly referrerOutcome: ReferralRewardOutcome | null;
  readonly refereeOutcome: ReferralRewardOutcome | null;
}

/**
 * Referral qualification and the two-sided reward — V3.2-C Story #12
 * (ADR-037).
 *
 * ## One method, one transaction, and an order that is the design
 *
 * `qualify` is called by the `BookingCompleted` handler and does everything or
 * nothing. The order below is not arbitrary:
 *
 *  1. **The compare-and-swap first.** It is the only guard, and everything
 *     after it lives inside its success branch — so a replay, an expired
 *     referral, and a customer who was never referred all cost exactly one
 *     `UPDATE` that affects zero rows and write nothing at all.
 *  2. **The cap second**, because it decides the referrer's outcome and must be
 *     charged inside the same transaction that recorded the qualification.
 *  3. **Both grants**, always both.
 *  4. **The ledger awards**, only for a side that is positive and uncapped.
 *  5. **The outbox event last**, so its payload states outcomes that are
 *     already durable in the same transaction.
 *
 * ## What makes it replay-safe
 *
 * The outbox is **at-least-once by design**; `V32-DEC-019` says redelivery is
 * the steady state rather than an exception. Safety here is the CAS predicate
 * `status = 'pending'`, not a preceding `SELECT` — and the affected-row count is
 * read through `returningRows`, never `result.length`, for the reason
 * `sql-result.ts` records at length: TypeORM's postgres driver returns
 * `[rows, rowCount]` for `UPDATE` **even with `RETURNING`**, so `result.length`
 * is always 2 and a guard reading it never fires. That exact mistake let a
 * revoked refresh token mint a session in this codebase once already.
 */
@Injectable()
export class ReferralQualificationService {
  private readonly logger = new Logger('ReferralQualificationService');

  constructor(
    @InjectRepository(ReferralAttributionEntity)
    private readonly referrals: Repository<ReferralAttributionEntity>,
    @Inject(REFERRAL_CLOCK) private readonly clock: ReferralClock,
    @Inject(REFERRAL_LOYALTY_PORT) private readonly loyalty: ReferralLoyaltyPort,
    @Inject(REFERRAL_REWARD_CONFIG) private readonly rewards: ReferralRewardConfig,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  /**
   * Qualifies the pending referral whose referee is `refereeUserId`, if there
   * is one and it is still live.
   *
   * Returns `qualified: false` for every no-op case — no referral, already
   * qualified, expired — and they are **deliberately indistinguishable to the
   * caller**, because the caller is an event handler with nothing to do
   * differently in any of them.
   *
   * ## Only `BookingCompleted` reaches here
   *
   * `V32-DEC-018` is emphatic and the refusals are enforced by there being no
   * other caller: registration, `BookingConfirmed`, and `OrderPaid` have no
   * path to this method. `OrderPaid` is the sharpest of the three — money moves
   * *before* delivery and can be refunded within minutes, so qualifying on
   * payment would maximise the window in which a reward exists for a service
   * that never happened.
   */
  async qualify(
    manager: EntityManager,
    input: { refereeUserId: string; bookingId: string },
  ): Promise<QualificationResult> {
    const now = this.clock.now();

    // -----------------------------------------------------------------------
    // 1. The compare-and-swap. The only guard, and the first write.
    // -----------------------------------------------------------------------
    //
    // `expires_at > $3` is STRICT: at `expires_at` exactly equal to the
    // qualification instant the referral does NOT qualify. `V32-DEC-017` gives
    // a pending referral 90 days, and the instant it lapses is the instant it
    // has lapsed -- both sides of that millisecond are tested.
    //
    // The status change, the instant, and the qualifying booking are set by
    // THIS ONE STATEMENT. `ck_referrals_qualification_complete` requires all
    // three to move together, so a crash between "marked qualified" and
    // "recorded which booking" is unrepresentable -- which is precisely the
    // state that would leave Story #28 unable to find the order.
    const raw = await manager.query(
      `UPDATE referral.referrals
          SET status = 'qualified',
              qualified_at = $2,
              qualifying_booking_id = $3
        WHERE referee_user_id = $1
          AND status = 'pending'
          AND expires_at > $2
      RETURNING id, referrer_user_id`,
      [input.refereeUserId, now, input.bookingId],
    );

    // `returningRows`, NEVER `raw.length`. See the class docblock.
    const won = returningRows<{ id: string; referrer_user_id: string }>(raw);
    if (won.length === 0) {
      // No pending referral, already qualified, or expired. A redelivered
      // event lands here, which is the steady state rather than an error.
      return { qualified: false, referralId: null, referrerOutcome: null, refereeOutcome: null };
    }

    const referralId = won[0].id;
    const referrerUserId = won[0].referrer_user_id;

    // -----------------------------------------------------------------------
    // 2. The cap. Inside the CAS's success branch, so a replay cannot charge it
    //    twice -- there is no second qualification to charge for.
    // -----------------------------------------------------------------------
    const withinCap = await this.chargeReferrerCap(manager, referrerUserId, now);

    // -----------------------------------------------------------------------
    // 3. Decide both sides. Independently, and BEFORE writing either.
    // -----------------------------------------------------------------------
    //
    // `V32-DEC-019`'s owner correction: the referee's reward remains
    // independently eligible when the referrer is capped, and both grants must
    // not be skipped merely because one side cannot be paid.
    const referrer: SideDecision = {
      side: 'referrer',
      recipientUserId: referrerUserId,
      // The cap is checked BEFORE the configured value, so a capped referrer
      // reads `capped` rather than `disabled_zero` even when the value is 0.
      // Both pay nothing today; they are different facts, and the one that
      // says "the platform would have paid but your monthly limit was spent"
      // is the one an operator needs when the value is later raised.
      outcome: !withinCap ? 'capped' : this.rewards.referrerPoints > 0 ? 'awarded' : 'disabled_zero',
      points: this.rewards.referrerPoints,
    };

    const referee: SideDecision = {
      side: 'referee',
      recipientUserId: input.refereeUserId,
      // No cap on this side, by owner decision, and the database refuses a
      // `capped` referee row outright.
      outcome: this.rewards.refereePoints > 0 ? 'awarded' : 'disabled_zero',
      points: this.rewards.refereePoints,
    };

    // -----------------------------------------------------------------------
    // 4. Write both grants, then award only what should be awarded.
    // -----------------------------------------------------------------------
    for (const decision of [referrer, referee]) {
      await this.recordGrant(manager, referralId, decision, now);
      await this.awardIfPayable(manager, referralId, decision);
    }

    // -----------------------------------------------------------------------
    // 5. The event, last and inside the transaction.
    // -----------------------------------------------------------------------
    //
    // Written to the outbox rather than published, so a rollback takes it with
    // everything else -- ADR-022's transactional outbox, and the reason a
    // consumer can never see a qualification the ledger does not reflect.
    await emitContractEvent(this.contracts, manager, ReferralOutboxEntity, ReferralQualified, {
      aggregateId: referralId,
      payload: {
        referralId,
        referrerUserId,
        refereeUserId: input.refereeUserId,
        qualifyingBookingId: input.bookingId,
        qualifiedAt: now.toISOString(),
        referrerOutcome: referrer.outcome,
        referrerPoints: referrer.points,
        refereeOutcome: referee.outcome,
        refereePoints: referee.points,
      },
    });

    // Ids and closed enums. NO CODE is an argument to this line and no points
    // figure either -- `V32-DEC-033` keeps referral material out of log lines,
    // and the way to keep it out is not to pass it.
    this.logger.log(
      `referral ${referralId} qualified (referrer ${referrer.outcome}, referee ${referee.outcome})`,
    );

    return {
      qualified: true,
      referralId,
      referrerOutcome: referrer.outcome,
      refereeOutcome: referee.outcome,
    };
  }

  /**
   * Charges one qualified referral against the referrer's monthly cap.
   *
   * Returns whether it fitted. `false` means the cap was already spent, and the
   * referrer side is marked `capped` -- the referral still qualifies and the
   * referee is still paid (`V32-DEC-019`).
   *
   * One conditional statement, which is the entire algorithm: the read and the
   * write are the SAME statement, so there is no window between them for a
   * concurrent qualification to slip through. `RETURNING` yields zero rows when
   * the `WHERE` on the `DO UPDATE` fails, which is how "the cap is spent" is
   * observed without a second query.
   *
   * `V32-DEC-019` forbids the alternative in as many words -- *never a
   * read-then-write*, which it calls `GAP-04` reproduced knowingly -- and also
   * forbids an in-memory counter, the HTTP throttler, Redis, and a
   * process-local mutex, each of which is per-process while the instance count
   * is `THROTTLE-STORE`-unresolved.
   *
   * The third use of this shape in the platform, after `chat.send_counters` and
   * `referral.claim_attempts`.
   */
  private async chargeReferrerCap(manager: EntityManager, referrerUserId: string, now: Date): Promise<boolean> {
    const period = tehranCalendarMonth(now);

    const raw = await manager.query(
      `INSERT INTO referral.referrer_counters (referrer_user_id, period, qualified_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (referrer_user_id, period) DO UPDATE
         SET qualified_count = referral.referrer_counters.qualified_count + 1,
             updated_at = now()
         WHERE referral.referrer_counters.qualified_count < $3
       RETURNING qualified_count`,
      [referrerUserId, period, REFERRAL_MONTHLY_CAP],
    );

    // An INSERT returns `rows` rather than `[rows, rowCount]`, so `raw.length`
    // would be correct here -- and `affectedAny` is used anyway, because a
    // reader should not have to know which of the two shapes this particular
    // statement produces in order to trust the guard.
    return affectedAny(raw);
  }

  /**
   * Records one side's grant. Always written, whatever the outcome.
   *
   * `V32-DEC-016` requires a zero to be **honestly disabled** rather than
   * silent: the row states that the platform decided, on this date, to award
   * this configured value -- which is a materially different claim from no row
   * at all, and is what makes the grant an explanation of a retained ledger
   * entry rather than a restatement of it.
   */
  private async recordGrant(
    manager: EntityManager,
    referralId: string,
    decision: SideDecision,
    now: Date,
  ): Promise<void> {
    await manager.getRepository(ReferralRewardGrantEntity).insert({
      id: uuidv7(),
      referralId,
      recipientUserId: decision.recipientUserId,
      side: decision.side,
      outcome: decision.outcome,
      points: decision.points,
      ledgerReason: LEDGER_REASON_BY_SIDE[decision.side],
      grantedAt: now,
    });
  }

  /**
   * Writes the loyalty row for one side, when there is one to write.
   *
   * ## The early return is the honest zero, and it is load-bearing
   *
   * A side that is `disabled_zero` or `capped` **does not call the ledger at
   * all**. `V32-DEC-016` requires that no loyalty row is written and **no
   * idempotency slot is consumed**, so a later approved figure can still be
   * awarded against the same referral id.
   *
   * That last clause is the whole reason. The ledger's uniqueness is
   * `(reference_type, reference_id, reason)`; a zero row would occupy
   * `('referral', <id>, referral_referrer_reward)` permanently, and the award
   * the business eventually approves would be silently deduplicated away. The
   * bug would surface as "we turned the reward on and nobody got anything",
   * long after the code that caused it shipped.
   *
   * `LoyaltyLedgerService.award` already returns early at zero and its docblock
   * already names this case -- so not calling is the **second** independent
   * reason the slot stays free. One more than strictly needed is the correct
   * number for a property that is expensive and silent to lose.
   *
   * The reference is `('referral', <referral id>)` -- never the booking id.
   * The guarantee is one reward per referral per side, and the booking id would
   * express one reward per *booking* per side, which is a different and weaker
   * statement the moment a referee books again.
   */
  private async awardIfPayable(
    manager: EntityManager,
    referralId: string,
    decision: SideDecision,
  ): Promise<void> {
    if (decision.outcome !== 'awarded') return;

    await this.loyalty.award(manager, {
      userId: decision.recipientUserId,
      reason: LEDGER_REASON_BY_SIDE[decision.side],
      referenceType: REFERRAL_LEDGER_REFERENCE_TYPE,
      referenceId: referralId,
      points: decision.points,
    });
  }
}
