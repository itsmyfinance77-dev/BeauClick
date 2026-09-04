import type { EntityManager } from 'typeorm';

/**
 * The one outbound port `business` declares — V3.3 #75, `V33-DEC-021`.
 *
 * ## Why a port and not an import
 *
 * `V33-DEC-021` Ruling 3 grants the `business` role at the moment a business is
 * created, atomically with it. The role lives in `identity.user_roles`, and
 * `business` may not import `identity`: ADR-011 forbids it and
 * `@nx/enforce-module-boundaries` fails the build over it.
 *
 * ## Why this is a SECOND token rather than provider's, reused
 *
 * `provider` declares its own `SELLER_OWNER_ROLE_GRANT` for the professional
 * half. `business` may not import `provider` either, so it cannot reach that
 * token — the same situation `search` and `provider` are in over
 * `WISHLIST_SAVED_TARGETS`, and it is resolved the same way: two domain-owned
 * tokens, ONE adapter instance bound to both in the composition root. Two
 * tokens are not two implementations.
 *
 * ## The signature takes the caller's `EntityManager`
 *
 * `V33-DEC-021` Ruling 8 requires ownership and role to commit together. An
 * implementation holding its own repository would run on a different
 * connection, could not see the uncommitted business row, and would not roll
 * back with it. Taking the manager makes that failure unrepresentable rather
 * than merely discouraged (ADR-042 §9).
 *
 * ## No role slug, and no affiliation, crosses this boundary
 *
 * The method name fixes the role, so `business` cannot ask for `professional`
 * or `administrator` — there is no parameter that could carry one. And the only
 * argument is the OWNER's user id: `business_staff` is not reachable from this
 * shape, so `V33-DEC-021` Ruling 6's "affiliation grants no global role" holds
 * structurally rather than by review.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `BusinessModule` declares the token and binds nothing. A composition that
 * forgets it fails to boot, rather than quietly creating business owners who
 * are refused on every capability-gated route.
 */
export interface BusinessOwnerRoleGrantPort {
  /**
   * Grants the `business` role to the user who now owns a business, inside
   * `manager`'s transaction.
   *
   * `ownerUserId` is **always** the session-resolved caller. No route in this
   * module accepts an owner identity from a request.
   *
   * Idempotent: a replayed creation grants nothing a second time and writes no
   * second audit row. Resolves to `true` only when a role row was actually
   * created.
   */
  grantBusinessOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean>;
}

export const BUSINESS_OWNER_ROLE_GRANT = Symbol('BEAUCLICK_BUSINESS_OWNER_ROLE_GRANT');
