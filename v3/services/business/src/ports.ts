import type { EntityManager } from 'typeorm';

import type { ScopedStaffRole } from './entities/staff-role-grant.entity';

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

/**
 * What a scoped-authority question looks like -- V3.3 Story #109 (`#44c`),
 * `V33-DEC-033` R2.
 *
 * `professionalId` is **required**, and that is the whole point. `practitioner_chat`
 * is practitioner-specific: it authorizes the booked practitioner's **own**
 * customer conversation and never every conversation the business holds. A caller
 * that could omit the practitioner would be asking a wider question than the
 * ruling permits, so the shape makes the narrow question the only expressible one.
 */
export interface ScopedStaffAuthorityRequest {
  /** The session user asking to act. Never a caller-supplied identity. */
  readonly userId: string;
  readonly role: ScopedStaffRole;
  /** The business the action is about -- for chat, the order's SNAPSHOTTED seller business. */
  readonly businessId: string;
  /** The practitioner the action is about -- for chat, the qualifying booking's `professional_id`. */
  readonly professionalId: string;
}

/**
 * The scoped-authority verifier -- V3.3 Story #109 (`#44c`), ADR-049 section 4.4.
 *
 * ## Why this is a SECOND, separate port
 *
 * `libs/auth`'s `PrivilegedCapabilityVerifier` takes `(userId, capability)` and
 * **no scope**, and its `PRIVILEGED_CAPABILITIES` list is shared with
 * `libs/audit`'s boot assertion. Adding a scope parameter there would change the
 * meaning of every existing privileged call site and make a scope-less call
 * against a scoped verifier exactly the confused deputy the separation prevents.
 * That port is **not** widened, altered or re-bound by this story.
 *
 * ## Everything is re-read live, on every request
 *
 * ADR-049 section 4.3 and `V33-DEC-033` R5. Nothing here is cached in a JWT
 * claim, a session or a memo. A revoked grant therefore fails on the **next**
 * request, and a stale access token carrying a valid base capability is refused.
 * This story adds no identity role and no token capability at all.
 *
 * ## It takes the caller's `EntityManager`
 *
 * Chat re-evaluates seller-side access **inside** its send transaction. An
 * implementation holding its own repository would take a second pool connection
 * while that transaction already holds one -- the exhaustion `chat.ports.ts`
 * documents from its own twenty-way concurrency case. Taking the manager makes
 * the read part of the caller's transaction on the caller's connection.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `BusinessModule` declares the token and binds nothing; the composition root
 * binds it. A composition that forgets it fails to boot rather than silently
 * denying -- or worse, silently allowing -- every scoped action.
 */
export interface ScopedStaffAuthorizerPort {
  /**
   * True only when **all** of these hold, each read live:
   *
   *  1. the business exists and is not soft-deleted;
   *  2. the user holds an `active` membership of that business;
   *  3. that membership's `professional_id` is non-null and equals
   *     `request.professionalId`;
   *  4. a grant of `request.role` for that membership and business exists with
   *     `revoked_at IS NULL`.
   *
   * Any other combination is false. There is no partial answer and no reason
   * code: the caller maps false to its own non-enumerating refusal.
   */
  hasLiveScopedAuthority(manager: EntityManager, request: ScopedStaffAuthorityRequest): Promise<boolean>;

  /**
   * Every `(businessId, professionalId)` pair this user currently holds `role`
   * for, as one batched read.
   *
   * Drives a consumer's list surface without an N+1: the caller resolves the
   * whole set once and filters its own rows against it, rather than asking this
   * port per row. An empty array is the ordinary answer for someone with no
   * grants.
   */
  liveScopedAuthorities(
    manager: EntityManager,
    userId: string,
    role: ScopedStaffRole,
  ): Promise<readonly { readonly businessId: string; readonly professionalId: string }[]>;

  /**
   * Every user who currently holds `role` for `(businessId, professionalId)`.
   *
   * The reverse direction, for a consumer that must decide **who to notify**
   * about something already scoped to one practitioner. It is deliberately not a
   * business-wide list: notifying every granted practitioner of a message meant
   * for one of them would disclose that the conversation exists.
   */
  usersWithLiveScopedAuthority(
    manager: EntityManager,
    role: ScopedStaffRole,
    businessId: string,
    professionalId: string,
  ): Promise<readonly string[]>;
}

export const SCOPED_STAFF_AUTHORIZER = Symbol('BEAUCLICK_SCOPED_STAFF_AUTHORIZER');

/** The one identity fact a staff invitation needs, and nothing else. */
export interface InvitableIdentity {
  readonly userId: string;
  /**
   * The professional profile this account owns, or `null`.
   *
   * Resolved **server-side** and never supplied by the inviter (`V33-DEC-033`
   * R2/R4). It becomes the membership's `professional_id`, which is what a
   * `practitioner_chat` grant is later checked against; a membership whose
   * resolved value is null can satisfy no such check and therefore authorizes
   * nothing -- fail-closed by construction rather than by a rule to remember.
   */
  readonly professionalId: string | null;
}

/**
 * Resolves an invitation phone number to an eligible account -- V3.3 Story #109
 * (`#44c`), `V33-DEC-030` D5 and ADR-049 section 4.5.
 *
 * ## Why a port and not an import
 *
 * The phone is the platform's OTP identity and lives in `identity.users`;
 * `canonicalizePhone` lives in `services/identity`. `business` may import neither
 * `identity` nor `provider` (ADR-011, enforced by
 * `@nx/enforce-module-boundaries`), so it declares the question and the
 * composition root binds an adapter -- the same arrangement
 * `BUSINESS_OWNER_ROLE_GRANT` and `LOCATION_CITY_CATALOGUE` already use, and the
 * same one `IdentityBackedRecipientResolver` already uses to read
 * `identity.users`.
 *
 * ## It answers for ONE phone the caller already holds, and enumerates nothing
 *
 * There is no list method, no count, no search and no shape that could carry a
 * reason. It returns `null` for a phone that does not canonicalise, for one with
 * no account, and for an account that is soft-deleted or erased -- all alike, so
 * `business` cannot distinguish them and could not leak the difference if it
 * wanted to. **No public user directory or search over users is authorized**
 * (`V33-DEC-030` D5).
 *
 * ## Nothing about an absent account is persisted
 *
 * ADR-049 section 4.6 as extended by `V33-DEC-033` R3: this is a **read**. It
 * writes no pending-invite row, no raw phone, no phone hash, no encrypted phone,
 * no lookup token, no outbox event and no notification -- durable or transient --
 * for any phone, and least of all for one with no account.
 */
export interface StaffInviteIdentityResolverPort {
  /**
   * The eligible account behind `rawPhone`, or `null`.
   *
   * Runs on `manager`'s transaction so resolution and the membership insert are
   * one atomic unit.
   */
  resolveInvitableIdentity(manager: EntityManager, rawPhone: string): Promise<InvitableIdentity | null>;
}

export const STAFF_INVITE_IDENTITY_RESOLVER = Symbol('BEAUCLICK_STAFF_INVITE_IDENTITY_RESOLVER');
