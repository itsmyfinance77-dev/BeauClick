import type { EntityManager } from 'typeorm';

/**
 * The referral domain's one reach into the loyalty ledger — V3.2-C Story #12
 * (ADR-011, ADR-037 §4).
 *
 * `referral` may not import `loyalty` (ADR-011, enforced by
 * `@nx/enforce-module-boundaries`: an `@beauclick/loyalty` import inside
 * `services/referral` fails CI). So it declares the narrowest thing it needs
 * and the composition root binds it to `LoyaltyLedgerService.award`.
 *
 * ## What this port deliberately cannot do
 *
 * It **awards**. It cannot read a balance, read a lifetime total, read a tier,
 * redeem, adjust, reverse, or enumerate anything.
 *
 * That is not minimalism for its own sake. A balance and a lifetime total are
 * facts about a person's **whole loyalty history**, most of which has nothing to
 * do with any referral — and a handler that held one would be one careless log
 * line or one widened event payload away from putting it somewhere
 * `V32-DEC-033` forbids. The award result therefore carries `awarded` and
 * nothing else, even though `LoyaltyLedgerService.award` returns four more
 * fields on the other side of this boundary.
 *
 * It also cannot write a **negative** row. `V32-DEC-017` makes a reversal a new
 * negative row under a **distinct reason**, and that belongs to Story #28 with
 * its own trigger and its own port. `points` is typed non-negative and the
 * domain never computes one, so a clawback cannot be smuggled through the
 * reward path.
 *
 * ## `ReferralModule` binds no default, exactly as the Story #27 ports
 *
 * A composition that forgets this token fails to boot rather than falling back
 * to something permissive. It matters more here than usual: a stub that
 * returned `{ awarded: true }` without writing anything would pass every test
 * written against the referral module alone, and would produce a platform that
 * recorded grants marked `awarded` against a ledger containing nothing — the
 * one failure mode that makes a reward system dishonest rather than broken.
 */

/**
 * The ledger reason a referral award carries.
 *
 * Deliberately a **local closed union** rather than an import of
 * `LoyaltyReason`: importing it would mean importing the loyalty package, which
 * is the boundary this port exists to avoid. The two literals are asserted
 * equal to loyalty's own constants at the composition root, where both are
 * legitimately in scope — so the duplication is checked rather than hoped for.
 */
export type ReferralLedgerReason = 'referral_referrer_reward' | 'referral_referee_reward';

export interface ReferralLoyaltyAward {
  /** The recipient. The referrer for one side, the referee for the other. */
  readonly userId: string;
  readonly reason: ReferralLedgerReason;
  /**
   * `('referral', <referral id>)` — never the booking id.
   *
   * The guarantee being bought is **one reward per referral per side**. The
   * booking id would express *one reward per booking per side*, which is a
   * different and weaker statement the moment a referee books a second time.
   */
  readonly referenceType: string;
  readonly referenceId: string;
  /**
   * The configured value for this side. **Non-negative**, and the caller must
   * not call at all when it is zero — see `ReferralLoyaltyPort.award`.
   */
  readonly points: number;
}

export interface ReferralLoyaltyPort {
  /**
   * Writes one loyalty row, idempotently, inside the caller's transaction.
   *
   * Returns whether a row was actually written. `false` is a **normal** return
   * value rather than an error: the outbox is at-least-once, so a redelivered
   * event finding the ledger's unique index already satisfied is the expected
   * steady state.
   *
   * ## The manager is not optional, and that is the point
   *
   * `LoyaltyLedgerService.award(input, manager)` already accepts one and opens
   * its own transaction when it is omitted. Omitting it here would commit a
   * ledger row that the qualification transaction could no longer roll back —
   * turning a replay-safe design into a double payment on the first partial
   * failure. It is also the connection-exhaustion defect V3.2-B recorded as
   * **bug #2**, where a port opening its own connection inside a caller's
   * transaction needed 2N connections against a pool of 10.
   *
   * ## Never called with zero points
   *
   * `V32-DEC-016`'s honest zero requires that a zero-valued side writes **no
   * ledger row and consumes no idempotency slot**, so a later approved figure
   * can still be awarded against the same referral id. The ledger already
   * behaves that way — `award` returns early at zero — but the domain does not
   * rely on that: it does not call at all, so the guarantee holds even if the
   * ledger's early return were ever removed. Two independent reasons the slot
   * stays free is one more than strictly needed, which is the correct number
   * for a property that is expensive and silent to lose.
   */
  award(manager: EntityManager, input: ReferralLoyaltyAward): Promise<{ awarded: boolean }>;
}

export const REFERRAL_LOYALTY_PORT = Symbol('BEAUCLICK_REFERRAL_LOYALTY_PORT');
