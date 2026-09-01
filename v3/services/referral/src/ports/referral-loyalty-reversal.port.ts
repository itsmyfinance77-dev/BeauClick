import type { EntityManager } from 'typeorm';

/**
 * The referral domain's clawback into the loyalty ledger — V3.2-C Story #28
 * (ADR-011, ADR-038 §§5–6).
 *
 * ## A SECOND port rather than a method on the award port, and the reward port
 * said so first
 *
 * `referral-loyalty.port.ts` records the boundary in terms: *"It also cannot
 * write a negative row. `V32-DEC-017` makes a reversal a new negative row under
 * a distinct reason, and that belongs to Story #28 with its own trigger and its
 * own port. `points` is typed non-negative and the domain never computes one, so
 * a clawback cannot be smuggled through the reward path."*
 *
 * That property is worth keeping. Adding a `reverse` method to the award port
 * would put both directions behind one token, and the reward path's guarantee —
 * that nothing it can do subtracts points — would become a convention rather
 * than a shape. Two tokens cost one line at the composition root and make the
 * two directions separately auditable.
 *
 * ## The amount is not an input, and that is the whole design
 *
 * There is no `points` field below. The caller names **which award** to reverse;
 * the ledger reads what it actually credited and negates that.
 *
 * `V32-DEC-017` requires the clawback to be exactly what was given, and reward
 * configuration may legitimately change between the award and the refund — the
 * business could raise the referrer reward from 0 to 50 in the months between a
 * booking and its refund. A port that accepted an amount would let a caller
 * compute one from current configuration, which is the single most likely way
 * this goes wrong and the one the decision names. With no parameter, an
 * over-claw has nowhere to enter.
 *
 * `expectedBasePoints` is the one figure that does cross, and it is a
 * **cross-check, not a source**: the domain passes what its own
 * `reward_grants` row recorded so the two persisted records are asserted to
 * agree. A mismatch means the grant no longer explains the ledger entry it
 * exists to explain, and the ledger raises rather than quietly preferring one.
 *
 * ## Why the grant cannot supply the amount by itself
 *
 * `reward_grants.points` is the **configured base**, not what was credited:
 * `LoyaltyLedgerService.award` applies the recipient's membership multiplier on
 * top of it. Reversing the grant's figure would under-claw exactly those
 * customers whose tier earned them a bonus, by an amount that grows with the
 * benefit and that nothing anywhere would report. So the **grant decides
 * whether** a side reverses — only it can tell `disabled_zero` from `capped` —
 * and the **ledger row decides how much** (ADR-038 §5).
 *
 * ## `ReferralModule` binds no default
 *
 * A composition that forgets this token fails to boot rather than falling back
 * to something permissive, exactly as the other four referral ports do. It
 * matters here for a specific reason: a stub returning `{ reversed: true }`
 * without writing anything would pass every test written against the referral
 * module alone, and would produce a platform that recorded reversals against a
 * ledger that still held the points — the reward system's mirror-image
 * dishonesty, and the one that costs real money.
 */

/**
 * The two reversal reasons.
 *
 * A **local closed union** rather than an import of `LoyaltyReason`, for the
 * reason the award port records: importing it would import the package the
 * boundary exists to avoid. The two literals are asserted equal to loyalty's
 * own constants at the composition root, where both are legitimately in scope,
 * so the duplication is checked rather than hoped for.
 */
export type ReferralReversalLedgerReason = 'referral_referrer_reversal' | 'referral_referee_reversal';

/** The reward reasons this port reverses. Kept separate so neither set can drift into the other. */
export type ReferralRewardLedgerReason = 'referral_referrer_reward' | 'referral_referee_reward';

export interface ReferralLoyaltyReversal {
  /** `('referral', <referral id>)` — the same reference the award carried. */
  readonly referenceType: string;
  readonly referenceId: string;
  /** The reason the original award was written under. */
  readonly originalReason: ReferralRewardLedgerReason;
  /**
   * The reason the negative row is written under.
   *
   * **Must differ from `originalReason`.** The distinct reason is what gives
   * the clawback its own slot under the ledger's
   * `UNIQUE(reference_type, reference_id, reason)` — and reusing the award's
   * reason would collide with the award itself, so the negative row would be
   * deduplicated away and **no clawback would ever be written**. The bug would
   * surface as "we refunded the order and the points are still there".
   */
  readonly reversalReason: ReferralReversalLedgerReason;
  /** The grant's persisted base points, for the cross-check described above. */
  readonly expectedBasePoints: number;
}

export interface ReferralLoyaltyReversalPort {
  /**
   * Writes one negative loyalty row, idempotently, inside the caller's
   * transaction.
   *
   * Returns whether a row was written and the **magnitude** clawed back.
   * `{ reversed: false, points: 0 }` is a **normal** return rather than an
   * error, and covers two genuinely different-but-equally-ordinary cases: the
   * original award never wrote a row (a `disabled_zero` or `capped` side), or
   * this reversal is already recorded because the outbox is at-least-once and
   * redelivery is the steady state.
   *
   * The magnitude comes back because the domain has to put it in
   * `ReferralReversed` and on the `reward_reversals` row. It is a fact about
   * **this referral's own reward** and nothing wider: no balance, no lifetime
   * total, and no tier crosses this boundary, exactly as the award port
   * refuses them.
   *
   * ## The manager is not optional, and that is the point
   *
   * `LoyaltyLedgerService.reverse(input, manager)` opens its own transaction
   * when the manager is omitted, which would commit a clawback the reversal
   * transaction could no longer roll back — leaving a customer with points
   * taken from a referral the platform still shows as qualified. It is also
   * V3.2-B's **bug #2**, where a port opening its own connection inside a
   * caller's transaction exhausted the pool with no error and no timeout.
   */
  reverse(
    manager: EntityManager,
    input: ReferralLoyaltyReversal,
  ): Promise<{ reversed: boolean; points: number }>;
}

export const REFERRAL_LOYALTY_REVERSAL_PORT = Symbol('BEAUCLICK_REFERRAL_LOYALTY_REVERSAL_PORT');
