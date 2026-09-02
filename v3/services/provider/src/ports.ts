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
