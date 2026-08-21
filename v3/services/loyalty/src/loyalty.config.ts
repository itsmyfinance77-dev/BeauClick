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
  pointsReferralQualified: number;
}

export const LOYALTY_POLICY_DEFAULTS: LoyaltyPolicy = {
  pointsBookingCompleted: 10,
  pointsReviewSubmitted: 5,
  pointsOrderCompleted: 10,
  // No V2 precedent -- referral rewards existed but split a configured pool
  // rather than awarding flat points. Zero, so referral qualification awards
  // nothing until the business sets a real figure, rather than inventing one.
  pointsReferralQualified: 0,
};

/** Reasons a ledger row can carry. The reason is part of the idempotency key, so this set is a contract. */
export const LOYALTY_REASONS = {
  bookingCompleted: 'booking_completed',
  reviewSubmitted: 'review_submitted',
  orderCompleted: 'order_completed',
  referralQualified: 'referral_qualified',
  manualAdjustment: 'manual_adjustment',
} as const;

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
      pointsReferralQualified: this.int('LOYALTY_POINTS_REFERRAL_QUALIFIED', LOYALTY_POLICY_DEFAULTS.pointsReferralQualified),
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
      case LOYALTY_REASONS.referralQualified:
        return p.pointsReferralQualified;
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
