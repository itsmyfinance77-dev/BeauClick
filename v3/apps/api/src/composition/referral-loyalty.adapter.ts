import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  LOYALTY_REASONS,
  LOYALTY_REFERRAL_REFERENCE_TYPE,
  LoyaltyConfig,
  LoyaltyLedgerService,
} from '@beauclick/loyalty';
import type {
  ReferralLedgerReason,
  ReferralLoyaltyAward,
  ReferralLoyaltyPort,
  ReferralRewardConfig,
} from '@beauclick/referral';

/**
 * The referral domain's one reach into the loyalty ledger — V3.2-C Story #12
 * (ADR-011, ADR-037 §4).
 *
 * `referral` may not import `loyalty` and lint enforces it, so the domain
 * declares `REFERRAL_LOYALTY_PORT` and this file — in `apps/api`, the one place
 * permitted to depend on both — binds it to the existing authorised
 * `LoyaltyLedgerService.award`.
 *
 * ## The two literals are checked here rather than hoped for
 *
 * `ReferralLedgerReason` is a local union in the referral package precisely
 * because importing `LoyaltyReason` would import the package the boundary
 * exists to avoid. That duplication is only safe if something asserts the two
 * agree, and this is the one file where both are legitimately in scope — so
 * `REASON_AGREEMENT` below is a compile-time assertion that the referral
 * domain's strings are exactly loyalty's constants. If either side is renamed,
 * the build fails here rather than at runtime with a reason nothing recognises
 * and an idempotency key nobody can reproduce.
 */
const REASON_AGREEMENT: Record<ReferralLedgerReason, ReferralLedgerReason> = {
  [LOYALTY_REASONS.referralReferrerReward]: LOYALTY_REASONS.referralReferrerReward,
  [LOYALTY_REASONS.referralRefereeReward]: LOYALTY_REASONS.referralRefereeReward,
};

/**
 * The reference type, likewise asserted equal across the boundary.
 *
 * Both sides reference `('referral', <referral id>)`. The referral domain
 * carries its own constant so it never has to import loyalty to build a
 * reference; this line is what keeps the two from drifting into two different
 * idempotency namespaces, which would silently let the same referral be paid
 * twice under two reference types.
 */
const REFERENCE_TYPE_AGREEMENT: typeof LOYALTY_REFERRAL_REFERENCE_TYPE = 'referral';

@Injectable()
export class ReferralLoyaltyAdapter implements ReferralLoyaltyPort {
  constructor(private readonly ledger: LoyaltyLedgerService) {}

  /**
   * Writes one loyalty row inside the caller's transaction.
   *
   * ## `overridePoints`, and why it is correct here
   *
   * `AwardInput.overridePoints` is documented as "only used by manual
   * adjustments", and passing it from an automated path deserves a reason
   * rather than a shrug.
   *
   * The reason is that the referral domain has **already decided** the figure —
   * it read both configured values, applied the monthly cap, and recorded the
   * outcome on a grant row inside this same transaction. Letting the ledger
   * re-derive the number from `pointsFor(reason)` would introduce a second
   * read of the same configuration at a slightly later instant, and the grant
   * row would then be able to disagree with the ledger row it exists to
   * explain. The override makes the grant authoritative, which is what
   * `V32-DEC-016`'s audit requirement needs.
   *
   * The tier multiplier still applies on the other side of this call, exactly
   * as it does for a booking award — the override replaces the BASE points, not
   * the benefit calculation, and a referred customer's membership tier is no
   * less real for the points having come from a referral.
   *
   * ## The manager is passed through, never omitted
   *
   * `award(input, manager)` runs inside the caller's transaction. Omitting it
   * would commit a ledger row the qualification could no longer roll back —
   * turning a replay-safe design into a double payment on the first partial
   * failure — and would open a second pool connection inside a transaction,
   * which is V3.2-B's bug #2.
   */
  async award(manager: EntityManager, input: ReferralLoyaltyAward): Promise<{ awarded: boolean }> {
    const result = await this.ledger.award(
      {
        userId: input.userId,
        reason: input.reason,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        overridePoints: input.points,
      },
      manager,
    );

    // `awarded` and NOTHING else. `AwardResult` also carries the entry id, the
    // points, the lifetime total and whether a tier changed; every one of those
    // is a fact about a person's whole loyalty history, and a referral handler
    // holding one would be a step from putting it in a payload `V32-DEC-033`
    // forbids (ADR-037 §4).
    return { awarded: result.awarded };
  }
}

/**
 * The two configured reward values, read from the authoritative `LoyaltyConfig`.
 *
 * A factory rather than a constant, because `LoyaltyConfig.policy` reads
 * `ConfigService` on every access — so the values a deployment sets are picked
 * up without the referral domain ever learning where they came from.
 *
 * `ReferralModule` binds a default of `{ 0, 0 }`, so this override changes
 * nothing on a default deployment. It exists so that setting
 * `LOYALTY_POINTS_REFERRAL_REFERRER` actually reaches the domain — and so the
 * real-PostgreSQL suite can prove the paying path by configuring those
 * variables rather than by editing a constant.
 */
export function referralRewardConfigFrom(config: LoyaltyConfig): ReferralRewardConfig {
  return {
    get referrerPoints(): number {
      return config.policy.pointsReferralReferrer;
    },
    get refereePoints(): number {
      return config.policy.pointsReferralReferee;
    },
  };
}

// Referenced so the two agreement assertions above are not dead code a bundler
// or a linter could drop. They exist to fail the BUILD, which requires them to
// be part of it.
void REASON_AGREEMENT;
void REFERENCE_TYPE_AGREEMENT;
