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

/**
 * The city representation a location surface may return -- V3.3 #108 (`#44b`).
 *
 * Exactly the two fields the platform's own public city catalogue exposes
 * (`GET /v1/cities` -> `{ id, name }`). Never `is_launched` or any other
 * internal city state (ADR-049 section 7, and #108's issue: "no ... city
 * state").
 */
export interface AssignableCity {
  readonly id: string;
  readonly name: string;
}

/**
 * The second outbound port `business` declares -- V3.3 Story #108 (`#44b`),
 * ADR-049 section 3.2.
 *
 * ## Why a port and not an import
 *
 * A location carries a city, and the city vocabulary is the existing
 * `provider.locations_cities`. `business` may not import `provider`: ADR-011
 * forbids it and `@nx/enforce-module-boundaries` restricts `scope:business` to
 * `scope:shared`. So `business` declares what it needs -- "is this city id one I
 * may assign, and what is its approved representation?" -- and the composition
 * root binds a `provider`-backed adapter, exactly as `BUSINESS_OWNER_ROLE_GRANT`
 * above is bound.
 *
 * ## The signature takes the caller's `EntityManager`
 *
 * ADR-049 section 8.2. The city check and the location write must be one
 * transaction: an adapter holding its own repository would run on a different
 * connection, so a city that vanished mid-request could still be accepted, and a
 * rolled-back location write would not roll back a check that already "passed".
 * Taking the manager makes that unrepresentable.
 *
 * ## It never enumerates, and never discloses a cause
 *
 * Both methods answer only for ids the caller **already holds** -- one id it
 * wants to assign, or the exact set its own locations already carry. Neither
 * lists cities, returns a count, or has a shape that could carry a reason.
 * `lookupAssignableCity` returns `null` for a nonexistent city and for an
 * existing-but-unavailable one alike (ADR-049 section 3.2, and #108's evidence
 * requirement that the two be indistinguishable), and `business` maps that `null`
 * to its single non-enumerating refusal.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `BusinessModule` declares the token and binds nothing. A composition that
 * forgets it fails to boot, rather than quietly refusing every location create.
 */
export interface LocationCityCataloguePort {
  /**
   * The assignable city for `cityId`, or `null` when it does not exist OR is not
   * currently available for assignment. Runs on `manager`'s transaction.
   *
   * Used to VALIDATE an assignment on create. "Available" is the platform's one
   * existing signal: `provider.locations_cities.is_launched`, the same predicate
   * `GET /v1/cities` already filters on. #108 invents no new city policy.
   */
  lookupAssignableCity(manager: EntityManager, cityId: string): Promise<AssignableCity | null>;

  /**
   * The representation of each already-assigned city in `cityIds`, keyed by id.
   *
   * Used to RENDER a location's city on read and mutation responses. Batched --
   * the whole collection in one call -- because one lookup per row is the N+1
   * pattern #108's evidence forbids by name. It ignores `is_launched`: a city
   * that became unavailable after a location was created still renders its name,
   * only new assignments to it are refused. An id with no row is simply absent
   * from the map.
   */
  describeCities(manager: EntityManager, cityIds: readonly string[]): Promise<ReadonlyMap<string, AssignableCity>>;
}

export const LOCATION_CITY_CATALOGUE = Symbol('BEAUCLICK_BUSINESS_LOCATION_CITY_CATALOGUE');
