/**
 * The two configured reward values, as the referral domain sees them —
 * V3.2-C Story #12 (`V32-DEC-016`, ADR-037 §3).
 *
 * ## Why this is a token rather than an import of `LoyaltyConfig`
 *
 * The values *live* in `LoyaltyConfig`, because they are loyalty-point figures
 * and belong beside the other point policies an operator tunes. But `referral`
 * may not import `loyalty` (ADR-011), so it declares the narrow shape it needs
 * and the composition root supplies it — the same treatment
 * `REFERRAL_LOYALTY_PORT` gets, for the same boundary reason.
 *
 * Two independent numbers, never one shared value. `V32-DEC-016` decided *(c)
 * both sides, with independent values and independent ledger reasons*, and a
 * single number here would quietly re-merge a decision the owner explicitly
 * split — it would also make the two ledger reasons pointless, since their
 * whole purpose is that the two sides are separately payable.
 */
export interface ReferralRewardConfig {
  /**
   * Points for the **referrer** when a referral qualifies within their monthly
   * cap. **0** by owner decision.
   */
  readonly referrerPoints: number;
  /**
   * Points for the **referee**. **0** by owner decision, and uncapped —
   * `V32-DEC-019` caps only the referrer, so an invited customer never loses
   * their own reward to somebody else's activity.
   */
  readonly refereePoints: number;
}

export const REFERRAL_REWARD_CONFIG = Symbol('BEAUCLICK_REFERRAL_REWARD_CONFIG');

/**
 * Both values at zero — the production default, and a **decided** value rather
 * than a placeholder.
 *
 * Bound by `ReferralModule` so the domain has correct behaviour with no
 * composition, and overridden at the composition root by the real
 * `LoyaltyConfig` figures. That direction is deliberate: an unconfigured
 * deployment awards nothing, which is the safe failure for an economics
 * setting and matches what `V32-DEC-016` actually decided.
 *
 * **Zero is honestly disabled, not "not yet implemented".** Qualification is
 * recorded, both grants are recorded with `outcome: 'disabled_zero'`, and no
 * ledger row and no idempotency slot is consumed — so a later approved figure
 * is still awardable against the same referral id.
 *
 * A non-zero figure is a new owner decision. Not a roadmap example, not V2's
 * `50`, and specifically not a test fixture: the suite proves the paying path
 * by injecting values through this token, and never by editing this constant.
 */
export const REFERRAL_REWARD_DEFAULTS: ReferralRewardConfig = {
  referrerPoints: 0,
  refereePoints: 0,
};
