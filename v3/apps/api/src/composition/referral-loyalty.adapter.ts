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
  ReferralLoyaltyReversal,
  ReferralLoyaltyReversalPort,
  ReferralReversalLedgerReason,
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
 * The two reversal reasons, asserted equal across the boundary — V3.2-C Story
 * #28 (ADR-038 §6).
 *
 * The mirror of `REASON_AGREEMENT` above, and it exists for a sharper reason
 * than the reward pair does. If a reversal reason drifted from loyalty's
 * constant, the negative row would be written under a string the ledger's
 * vocabulary does not contain — so it would still deduplicate correctly
 * against itself, still sum into the balance, and still be invisible to every
 * query that filters by reason. The clawback would work and be unauditable.
 * This line makes that a build failure.
 */
const REVERSAL_REASON_AGREEMENT: Record<ReferralReversalLedgerReason, ReferralReversalLedgerReason> = {
  [LOYALTY_REASONS.referralReferrerReversal]: LOYALTY_REASONS.referralReferrerReversal,
  [LOYALTY_REASONS.referralRefereeReversal]: LOYALTY_REASONS.referralRefereeReversal,
};

/**
 * The referral domain's clawback into the loyalty ledger — V3.2-C Story #28
 * (ADR-011, ADR-038 §§5–6).
 *
 * A **second** adapter behind a **second** token rather than a method on
 * `ReferralLoyaltyAdapter`, because the reward port's own docblock reserved it
 * that way: *"It also cannot write a negative row … that belongs to Story #28
 * with its own trigger and its own port."* Keeping them apart keeps the reward
 * path's guarantee structural — nothing it can do subtracts points — instead of
 * turning it into a convention.
 *
 * ## No amount crosses this boundary, and that is the whole design
 *
 * `ReferralLoyaltyReversal` has no `points` field. The domain names **which
 * award** to reverse; `LoyaltyLedgerService.reverse` reads what that award
 * actually credited and negates it.
 *
 * `V32-DEC-017` requires the clawback to be exactly what was given, and reward
 * configuration may legitimately change between the award and the refund — the
 * business could raise the referrer reward from 0 to 50 in the months between a
 * booking and its refund. A port that accepted an amount would let a caller
 * compute one from *current* configuration, which is the single most likely way
 * this goes wrong. With no parameter, an over-claw has nowhere to enter.
 *
 * `expectedBasePoints` is the one figure that does cross and it is a
 * **cross-check, not a source**: the grant row's persisted base is compared
 * against the original entry's, and the ledger raises on disagreement. The
 * grant exists to explain that ledger row, so the two silently diverging is
 * itself the bug.
 *
 * ## Why the grant cannot supply the amount
 *
 * `reward_grants.points` is the configured **base**; `award()` credits
 * `Math.round(base * multiplierBp / 10000)` using the recipient's membership
 * benefit at award time. Reversing the grant's figure would under-claw exactly
 * those customers whose tier earned them a bonus, by an amount that grows with
 * the benefit and that nothing anywhere would report. So the grant decides
 * *whether*, and the ledger decides *how much* (ADR-038 §5).
 */
@Injectable()
export class ReferralLoyaltyReversalAdapter implements ReferralLoyaltyReversalPort {
  constructor(private readonly ledger: LoyaltyLedgerService) {}

  /**
   * Writes one negative loyalty row inside the caller's transaction.
   *
   * The manager is passed through and never omitted. `reverse(input, manager)`
   * opens its own transaction when it is absent, which would commit a clawback
   * the reversal transaction could no longer roll back — leaving a customer
   * with points taken from a referral the platform still shows as qualified —
   * and would open a second pool connection inside a transaction, which is
   * V3.2-B's bug #2.
   */
  async reverse(
    manager: EntityManager,
    input: ReferralLoyaltyReversal,
  ): Promise<{ reversed: boolean; points: number }> {
    const result = await this.ledger.reverse(
      {
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        originalReason: input.originalReason,
        reversalReason: input.reversalReason,
        expectedBasePoints: input.expectedBasePoints,
      },
      manager,
    );

    // `reversed` and the magnitude, and nothing else. The magnitude is a fact
    // about THIS referral's own reward -- the domain needs it for the event and
    // the audit row -- while a balance or a lifetime total would be a fact about
    // the person's whole loyalty history, which is what the reward adapter
    // above refuses to return for the same reason.
    return { reversed: result.reversed, points: result.points };
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
void REVERSAL_REASON_AGREEMENT;
void REFERENCE_TYPE_AGREEMENT;
