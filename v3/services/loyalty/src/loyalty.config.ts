import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Every business-tunable loyalty number, in one place, all configurable, all
 * flagged.
 *
 * `GAP-10` is explicit that V2's loyalty constants -- 10 points per booking,
 * 5 per review, 10 per shop order -- are **provisional placeholder policy, not
 * a business decision**. V2's own `EarningRules` docblock says so in as many
 * words. This phase therefore does two things and deliberately not a third:
 *
 *   * carries the SHAPE forward (a flat award per qualifying event, keyed by
 *     reason, multiplied by any tier/membership benefit);
 *   * makes every value environment-configurable, so adopting a real policy
 *     is a config change and not a deployment of new code;
 *   * does NOT invent economics. The defaults below are V2's placeholders
 *     reproduced exactly, and `unresolvedPolicies()` reports them as
 *     unresolved so the state is visible in the running system rather than
 *     buried in a document.
 *
 * The alternative -- picking "better" numbers now -- would silently convert a
 * known-open business question into an apparently-settled implementation
 * detail, which is precisely what GAP-10 warns against.
 */
export interface LoyaltyPolicy {
  pointsBookingCompleted: number;
  pointsReviewSubmitted: number;
  pointsOrderCompleted: number;
  /**
   * The referrer's and the referee's rewards for a qualified referral, as TWO
   * independent values (V3.2-C Story #12, `V32-DEC-016`, ADR-037 §3).
   *
   * Two rather than one, and the reason is mechanical rather than stylistic.
   * The ledger's idempotency is
   * `UNIQUE (reference_type, reference_id, reason)`, so one shared reason
   * would make the two people's rewards for ONE referral id collide in the
   * same slot — the second would silently never happen. Two values without two
   * reasons would be the same bug with extra configuration.
   */
  pointsReferralReferrer: number;
  pointsReferralReferee: number;
}

export const LOYALTY_POLICY_DEFAULTS: LoyaltyPolicy = {
  pointsBookingCompleted: 10,
  pointsReviewSubmitted: 5,
  pointsOrderCompleted: 10,
  /**
   * **Both zero, and zero is HONESTLY DISABLED rather than a placeholder.**
   *
   * `V32-DEC-016` decided both values and set both to 0: qualification is
   * still recorded, the reward grant is still recorded, and **no ledger row is
   * written and no idempotency slot is consumed** — so a later approved figure
   * can still be awarded against the same referral id. `award()` below the
   * fold implements exactly that, and Story #12 proves it structurally against
   * the real table rather than trusting this comment.
   *
   * **These are not placeholders awaiting a number, unlike the three above.**
   * The three flat awards are `GAP-10` provisional V2 values that
   * `unresolvedPolicies()` reports as unresolved. These two are a **closed
   * owner decision** whose current answer happens to be zero, which is why
   * they are deliberately absent from that report: telling an operator the
   * referral values are "unresolved" would be false.
   *
   * A non-zero figure is a NEW owner decision. Not a roadmap example, not a
   * legacy V2 number, not a test fixture, and specifically not V2's 50.
   */
  pointsReferralReferrer: 0,
  pointsReferralReferee: 0,
};

/**
 * Reasons a ledger row can carry. The reason is part of the idempotency key, so
 * this set is a contract.
 *
 * ## `referral_qualified` was removed by V3.2-C Story #12, deliberately
 *
 * A single `referral_qualified` reason lived here from Phase 2 and is exactly
 * the shape `V32-DEC-016` forbids: one reason cannot idempotently pay two
 * people against one referral id.
 *
 * It was removed rather than left beside the pair below, and removing it
 * destroyed nothing — it was **structurally unwritable**. Its configured value
 * was 0, and `award()` returns before the `INSERT` at zero, so no row could
 * ever have carried it; zero rows was verified against the real table before
 * the change. Leaving an unused single-sided reason in a set this codebase
 * calls a contract would have put the one shape the decision forbids within
 * easy reach of the next author.
 */
export const LOYALTY_REASONS = {
  bookingCompleted: 'booking_completed',
  reviewSubmitted: 'review_submitted',
  orderCompleted: 'order_completed',
  /**
   * The two referral reasons (`V32-DEC-016`).
   *
   * Both are referenced as `('referral', <referral id>)` — never the booking
   * id. The guarantee being bought is *one reward per referral per side*, and
   * the booking id would express *one reward per booking per side*, which is a
   * different and weaker statement the moment a referee books twice.
   */
  referralReferrerReward: 'referral_referrer_reward',
  referralRefereeReward: 'referral_referee_reward',
  /**
   * The two referral REVERSAL reasons — V3.2-C Story #28 (`V32-DEC-017`,
   * ADR-038 §5).
   *
   * ## Distinct reasons are the mechanism, not a labelling convenience
   *
   * `V32-DEC-017` binds a reversal to *"a new negative row under a distinct
   * reason, never a mutation"*, and the ledger's idempotency is
   * `UNIQUE(reference_type, reference_id, reason)`. So the distinct reason is
   * exactly what gives the clawback **its own idempotency slot** against the
   * same `('referral', <referral id>)` reference: a redelivered `OrderRefunded`
   * finds the slot taken and writes nothing, while the original award's slot
   * stays occupied by the row it always was.
   *
   * Reusing the reward reason with a negative value would have been the
   * alternative, and it fails on the same index: the second insert would
   * collide with the award and be deduplicated away, so **no clawback would
   * ever be written**. The bug would surface as "we refunded the order and the
   * points are still there".
   *
   * Four reasons rather than two, for the same reason there are two rather than
   * one: one reason cannot idempotently address two people, and a reward and
   * its reversal cannot share a slot.
   *
   * `pointsFor()` returns 0 for both, deliberately. **A reversal amount is
   * never configured** — it comes from the persisted original ledger row
   * (ADR-038 §5), because reward configuration may change between the award and
   * the refund, and a customer must not have more clawed back than they were
   * ever given.
   */
  referralReferrerReversal: 'referral_referrer_reversal',
  referralRefereeReversal: 'referral_referee_reversal',
  manualAdjustment: 'manual_adjustment',
} as const;

/**
 * The reference type all four referral reasons use. The id is the REFERRAL id.
 *
 * The reversal shares the reference with the award it reverses, which is what
 * makes the two rows findable as one story: `('referral', <id>)` with four
 * possible reasons is a complete account of what a referral did to a balance.
 */
export const LOYALTY_REFERRAL_REFERENCE_TYPE = 'referral';

export type LoyaltyReason = (typeof LOYALTY_REASONS)[keyof typeof LOYALTY_REASONS];

/**
 * Tier qualification basis.
 *
 * V2 used LIFETIME EARNED -- the sum of every positive award ever made, never
 * the spendable balance, so a redemption can never demote a customer. That
 * rule is preserved and is not in question.
 *
 * What IS in question, and is flagged rather than decided: whether
 * qualification should instead be ROLLING (last 12 months) or ANNUAL
 * (re-qualify each year). V2's own docblock names both as
 * NEEDS_BUSINESS_DECISION and implements neither. This enum exists so the
 * choice is a configuration value with a real implementation behind the
 * default, rather than an assumption baked into a SQL query.
 */
export type TierQualificationBasis = 'lifetime' | 'rolling_365';

@Injectable()
export class LoyaltyConfig {
  constructor(private readonly config: ConfigService) {}

  get policy(): LoyaltyPolicy {
    return {
      pointsBookingCompleted: this.int('LOYALTY_POINTS_BOOKING_COMPLETED', LOYALTY_POLICY_DEFAULTS.pointsBookingCompleted),
      pointsReviewSubmitted: this.int('LOYALTY_POINTS_REVIEW_SUBMITTED', LOYALTY_POLICY_DEFAULTS.pointsReviewSubmitted),
      pointsOrderCompleted: this.int('LOYALTY_POINTS_ORDER_COMPLETED', LOYALTY_POLICY_DEFAULTS.pointsOrderCompleted),
      pointsReferralReferrer: this.int('LOYALTY_POINTS_REFERRAL_REFERRER', LOYALTY_POLICY_DEFAULTS.pointsReferralReferrer),
      pointsReferralReferee: this.int('LOYALTY_POINTS_REFERRAL_REFEREE', LOYALTY_POLICY_DEFAULTS.pointsReferralReferee),
    };
  }

  get tierQualificationBasis(): TierQualificationBasis {
    const value = this.config.get<string>('LOYALTY_TIER_BASIS');
    return value === 'rolling_365' ? 'rolling_365' : 'lifetime';
  }

  pointsFor(reason: LoyaltyReason): number {
    const p = this.policy;
    switch (reason) {
      case LOYALTY_REASONS.bookingCompleted:
        return p.pointsBookingCompleted;
      case LOYALTY_REASONS.reviewSubmitted:
        return p.pointsReviewSubmitted;
      case LOYALTY_REASONS.orderCompleted:
        return p.pointsOrderCompleted;
      case LOYALTY_REASONS.referralReferrerReward:
        return p.pointsReferralReferrer;
      case LOYALTY_REASONS.referralRefereeReward:
        return p.pointsReferralReferee;
      default:
        return 0;
    }
  }

  /**
   * Which policy values are still running on a provisional default.
   *
   * Surfaced by the admin status route so "nobody has signed these off yet"
   * is a fact an operator can see in the product, not a claim buried in a gap
   * register that nobody re-reads.
   */
  unresolvedPolicies(): string[] {
    const unresolved: string[] = [];
    const check = (key: string, current: number, provisional: number) => {
      if (current === provisional && this.config.get(key) === undefined) {
        unresolved.push(`${key} (=${provisional}, V2 placeholder, GAP-10 NEEDS_BUSINESS_DECISION)`);
      }
    };
    const p = this.policy;
    check('LOYALTY_POINTS_BOOKING_COMPLETED', p.pointsBookingCompleted, LOYALTY_POLICY_DEFAULTS.pointsBookingCompleted);
    check('LOYALTY_POINTS_REVIEW_SUBMITTED', p.pointsReviewSubmitted, LOYALTY_POLICY_DEFAULTS.pointsReviewSubmitted);
    check('LOYALTY_POINTS_ORDER_COMPLETED', p.pointsOrderCompleted, LOYALTY_POLICY_DEFAULTS.pointsOrderCompleted);
    if (this.config.get('LOYALTY_TIER_BASIS') === undefined) {
      unresolved.push('LOYALTY_TIER_BASIS (=lifetime; rolling/annual re-qualification unresolved, GAP-10)');
    }
    return unresolved;
  }

  private int(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
