import type { EntityManager } from 'typeorm';

import type { WishlistTargetRef } from '@beauclick/wishlist-contract';

/**
 * The one outbound port `provider` declares (V3.2-C Story #9, ADR-034).
 *
 * ## Why a port and not an import
 *
 * A professional profile and a service listing are discovery surfaces, and issue
 * #9 requires them to carry the caller's own saved state. That state lives in
 * `wishlist.saved_items`, and `provider` may not import `wishlist` — ADR-011
 * forbids a domain from depending on another and `@nx/enforce-module-boundaries`
 * fails CI over it. So `provider` declares what it needs and the composition
 * root binds it, the way `booking` declares `PROFESSIONAL_DIRECTORY` and
 * `waitlist` declares `PROFESSIONAL_OWNER_LOOKUP`.
 *
 * `@beauclick/wishlist-contract` IS importable here: it is `scope:shared`, has
 * zero dependencies, and exists precisely so the two sides can share a
 * vocabulary without sharing a module.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `ProviderModule` declares the token and binds nothing. A composition that
 * forgets it fails to boot, rather than quietly reporting `saved: null` for
 * every customer on every page — a regression that would be invisible in
 * production and would pass every test in this module.
 *
 * ## What this port must never become
 *
 * It answers **membership for one named subject**. It has no method that returns
 * a count, a total, a ranking input, or anything about a customer other than the
 * one named in the call. `V32-DEC-021` refuses a public save count outright, and
 * the refusal is structural here: there is no shape in this file that could
 * carry one.
 */

export interface WishlistSavedTargetsPort {
  /**
   * Which of `targets` the customer `userId` has saved, as a set of
   * `"{targetType}:{targetId}"` keys.
   *
   * `userId` is **always** the session-resolved caller. No route in this module
   * accepts a user, customer, or owner identity from a request, and this port is
   * called with `@CurrentUser().userId` and nothing else.
   *
   * Batched: the whole page in one call, because one call per result is the N+1
   * pattern issue #9 forbids by name.
   *
   * Keyed by `{targetType}:{targetId}` rather than by bare id because a
   * professional id and a service id are both UUIDs from the same generator, so
   * a bare id is ambiguous between the two tables.
   */
  savedTargets(userId: string, targets: readonly WishlistTargetRef[]): Promise<ReadonlySet<string>>;
}

export const WISHLIST_SAVED_TARGETS = Symbol('BEAUCLICK_PROVIDER_WISHLIST_SAVED_TARGETS');

/**
 * The second outbound port `provider` declares — V3.3 #75, `V33-DEC-021`.
 *
 * ## Why a port and not an import
 *
 * `V33-DEC-021` Ruling 2 grants the `professional` role at the moment a
 * professional profile is created, atomically with it. The role lives in
 * `identity.user_roles`, and `provider` may not import `identity`: ADR-011
 * forbids it and `@nx/enforce-module-boundaries` fails the build over it. So
 * `provider` declares what it needs and the composition root binds the
 * identity-backed adapter, exactly as `WISHLIST_SAVED_TARGETS` above already
 * does.
 *
 * ## The signature takes the caller's `EntityManager`, and that is the whole point
 *
 * `V33-DEC-021` Ruling 8 requires ownership and role to commit together.
 * An implementation that used its own repository would run on a different
 * connection, could not see the uncommitted professional row, and would not roll
 * back with it — leaving either a role for a profile that never existed or a
 * profile whose owner cannot act on it. Taking the manager makes that failure
 * unrepresentable rather than merely discouraged, the same construction
 * `OwnedSubscriberPartyResolver` uses (ADR-042 §9).
 *
 * ## No role slug crosses this boundary
 *
 * The method name fixes the role. `provider` cannot ask for `business`,
 * `administrator`, or anything else, because there is no parameter that could
 * carry it — so `V33-DEC-021`'s "role selection is fixed by the server-side
 * port" is a property of this shape rather than a rule somebody has to follow.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `ProviderModule` declares the token and binds nothing. A composition that
 * forgets it fails to boot, rather than quietly creating sellers who are
 * refused on every capability-gated route — which is #75 itself, and exactly
 * the regression that would be invisible in production.
 */
export interface SellerOwnerRoleGrantPort {
  /**
   * Grants the `professional` role to the user who now owns a professional
   * profile, inside `manager`'s transaction.
   *
   * `ownerUserId` is **always** the session-resolved caller. No route in this
   * module accepts an owner identity from a request.
   *
   * Idempotent: a replayed creation grants nothing a second time and writes no
   * second audit row. Resolves to `true` only when a role row was actually
   * created.
   */
  grantProfessionalOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean>;
}

export const SELLER_OWNER_ROLE_GRANT = Symbol('BEAUCLICK_PROVIDER_SELLER_OWNER_ROLE_GRANT');
