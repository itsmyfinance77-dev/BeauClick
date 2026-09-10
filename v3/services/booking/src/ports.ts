import type { EntityManager } from 'typeorm';

/**
 * booking-service's outbound ports.
 *
 * ADR-011 forbids one `services/*` package importing another, so
 * booking-service cannot call provider-service to answer "which user owns
 * this professional profile?" -- yet it genuinely needs that answer to
 * authorize a professional acting on a booking.
 *
 * The resolution is a port declared HERE and implemented in `apps/api`
 * (`scope:app`, the one tier permitted to compose domains). booking-service
 * depends on an interface it owns; the composition root supplies the
 * provider-backed adapter. Tests supply a fake. No module boundary is
 * crossed and no ownership decision is delegated to a caller.
 */
export interface ProfessionalDirectory {
  /** The identity user id that owns this professional profile, or null if there is no such profile. */
  ownerUserIdFor(professionalId: string): Promise<string | null>;

  /** The professional profile this user owns, or null if they have none. */
  professionalIdForOwner(userId: string): Promise<string | null>;
}

export const PROFESSIONAL_DIRECTORY = Symbol('BEAUCLICK_PROFESSIONAL_DIRECTORY');

/**
 * The entitlement seam a cancellation passes through -- V3.3 #58 (`#58a`),
 * ADR-046 §8, `V33-DEC-025` Ruling 8.
 *
 * ## Why booking-service declares a port it does not understand
 *
 * A cancelled confirmed booking may owe its seller a credit back, and that
 * return must be written in the SAME transaction as the cancellation -- a
 * cancellation that rolls back must leave no return, and a failed return must
 * roll back the cancellation. Only booking-service owns that transaction.
 *
 * ADR-011 forbids `services/booking` importing `services/commercial-policy`, so
 * the port is declared here and implemented in `apps/api`, exactly as
 * `PROFESSIONAL_DIRECTORY` above is. Booking-service therefore never learns
 * what a credit is; it only offers the transaction.
 *
 * ## What crosses, and what deliberately does not
 *
 * The manager, the booking id, the SERVER-DERIVED actor type, and whether the
 * booking was confirmed before this cancellation. No party, grant, quantity,
 * subscription or free-text reason: a caller-supplied party on an entitlement
 * seam is a grant of somebody else's credits, and a customer's cancellation
 * sentence must never reach the other party's commercial ledger.
 *
 * `wasConfirmed` is passed because an expired pending hold consumed nothing and
 * must return nothing -- a fact booking-service knows and the adapter cannot
 * re-derive after the row has already moved to `cancelled`.
 */
export interface BookingCancellationEntitlementHook {
  onBookingCancellation(
    manager: EntityManager,
    bookingId: string,
    actorType: string,
    wasConfirmed: boolean,
  ): Promise<void>;
}

export const BOOKING_CANCELLATION_ENTITLEMENT_HOOK = Symbol('BEAUCLICK_BOOKING_CANCELLATION_ENTITLEMENT_HOOK');

/**
 * The authoritative delivery location for a professional's new slots --
 * V3.3 Story #127 (`#127a`), `V33-DEC-035` R3.
 *
 * ## Why booking declares a question it cannot answer
 *
 * A slot is created only by the professional whose session it is, but WHERE they
 * deliver is a `business` fact: it lives on their consented `business_staff`
 * membership, which only the business owner may set. ADR-011 forbids
 * `services/booking` importing `services/business`, so the port is declared here
 * and implemented in `apps/api` -- exactly as `PROFESSIONAL_DIRECTORY` and
 * `BookingCancellationEntitlementHook` above already are. Booking therefore never
 * learns what a membership, a branch or an owner is; it only asks where this
 * professional currently delivers.
 *
 * ## It takes the caller's `EntityManager`, and that is load-bearing
 *
 * The answer is snapshotted onto the row being inserted, so the read must happen
 * inside the same transaction as the insert. Taking the manager is what makes a
 * concurrent owner rebinding and a concurrent slot creation linearise: the
 * resolver sees either the complete old binding or the complete new one, never a
 * half-applied change, because the owner's own transaction holds `FOR UPDATE` on
 * the membership row it is rewriting.
 *
 * ## Fail-closed, and never a guess
 *
 * `null` is returned for every case that is not an unambiguous, currently-valid
 * binding: a standalone professional, an inactive/invited/declined/removed
 * membership, a membership with no branch, a branch that is suspended or closed,
 * and -- deliberately -- a user who merely OWNS a business without holding an
 * active membership in it. **No first business and no first location is ever
 * selected**; ownership is not a binding, and a business may legitimately have
 * many branches. `null` means "no context", which is exactly how every slot
 * behaved before this port existed.
 */
export interface DeliveryLocationDirectory {
  /**
   * The branch this professional currently delivers at, or `null`.
   *
   * One query answers both the present and absent cases, so the cost and shape of
   * the call do not depend on whether a binding exists.
   */
  deliveryLocationFor(manager: EntityManager, professionalId: string): Promise<string | null>;
}

export const DELIVERY_LOCATION_DIRECTORY = Symbol('BEAUCLICK_DELIVERY_LOCATION_DIRECTORY');

/**
 * The eligible-candidate resolution port -- V3.3 Story #131 (`#127b`),
 * `V33-DEC-035` R5/R7.
 *
 * ## Why booking declares a question it cannot answer
 *
 * Which resources are eligible for a service is a `business` fact: it depends
 * on `business.service_resource_requirements` (what kind is required) and
 * `business.location_resources` (which resources of that kind exist at a
 * location). ADR-011 forbids `services/booking` importing `services/business`,
 * so the port is declared here and implemented in `apps/api` -- exactly as
 * `DeliveryLocationDirectory` above already is. Booking therefore never learns
 * what a requirement or a resource catalogue is; it only asks which internal
 * ids are eligible for a service at a location.
 *
 * ## This story does not call it
 *
 * `#131` builds and tests this port and its adapter; it does not wire the port
 * into any existing booking read or write path. `#128` (`#110b`) is the
 * consumer that will call it at booking time, lock a candidate under a
 * PostgreSQL exclusion constraint, and write
 * `booking.booking_resource_assignments`. Nothing in `#131` selects a
 * resource, creates an assignment, or otherwise changes booking's observable
 * behaviour -- a nullable `serviceId` or `deliveryLocationId` continues to
 * behave byte-identically to the pre-#131 path on every existing route.
 *
 * ## It returns ELIGIBLE resources, never a winner
 *
 * `V33-DEC-035` R7. The result is the complete candidate set in a
 * deterministic order, never a single selection: there is no `ORDER BY ...
 * LIMIT 1` inside the implementation, because picking one is `#128`'s job
 * under its own locking discipline, not this port's. "Eligible" means active,
 * at the right location, of the right kind -- not "currently free"; this port
 * computes no occupancy and is not a busy/free oracle.
 *
 * ## `null` means "nothing to resolve"; `[]` means "resolved, and refused"
 *
 * This distinction is `#128`'s own contract addition -- `#131` shipped this
 * port with no consumer and documented that a future caller would need
 * SOME way to tell "no requirement" apart from "requirement genuinely
 * unmet," without committing to a mechanism. `#128` is that caller, and this
 * is the mechanism: a null `serviceId`, a null `deliveryLocationId`, or a
 * concrete service with no requirement row all resolve to `null` -- booking
 * proceeds with no assignment, exactly as it always has. A requirement row
 * that DOES exist but matches no active resource at that location resolves
 * to `[]` -- the genuine refusal case. Neither ever discloses the required
 * kind, a candidate count, or which of the `null`-cases applied
 * (`V33-DEC-035` R9 governs what may reach a CUSTOMER response, and neither
 * value here ever does; the distinction is purely an internal `booking`↔
 * `business` coordination signal).
 *
 * ## It takes the caller's `EntityManager`
 *
 * `#128` reads candidates inside the SAME transaction that later locks and
 * assigns one, so a resource retired between the read and the lock cannot be
 * assigned -- the same discipline `DeliveryLocationDirectory` documents for
 * the slot snapshot.
 *
 * ## Nothing is provided by default, deliberately
 *
 * `BookingModule` declares the token and binds nothing. A composition that
 * forgets it fails to boot, rather than `#128` silently resolving against an
 * empty adapter and refusing every resource-bearing booking.
 */
export interface EligibleResourceDirectory {
  /**
   * The eligible internal `business.location_resources.id` values for
   * `serviceId` at `deliveryLocationId`, deterministically ordered.
   *
   * Returns `null` when `serviceId` is `null`, when `deliveryLocationId` is
   * `null`, or when the service has no requirement row at all -- no
   * assignment is needed, and the caller must not refuse. Returns `[]` when
   * a requirement row exists but no active resource of the required kind
   * exists at that location -- the caller must refuse. Returns a non-empty
   * array of candidates otherwise.
   */
  eligibleResourcesFor(
    manager: EntityManager,
    serviceId: string | null,
    deliveryLocationId: string | null,
  ): Promise<readonly string[] | null>;
}

export const ELIGIBLE_RESOURCE_DIRECTORY = Symbol('BEAUCLICK_ELIGIBLE_RESOURCE_DIRECTORY');

/**
 * A namespace for this module's advisory locks -- V3.3 Story #128 (`#110b`).
 *
 * PostgreSQL's advisory-lock space is global to the database, so an
 * unqualified key would collide with any future caller that happened to hash
 * the same value. `business.service_resource_requirement.service.ts` claims
 * `0x73727271` ('srrq') and `wishlist.service.ts` claims `0x77697368`
 * ('wish'); this is a third, disjoint one -- `'bkas'` (BooKing Assignment) --
 * claimed explicitly for the same reason.
 */
export const RESOURCE_ASSIGNMENT_LOCK_NAMESPACE = 0x62_6b_61_73 | 0; // 'bkas'

/**
 * Locks `resourceId` for the remainder of the caller's transaction --
 * V3.3 Story #128 (`#110b`), ADR-049 §6.6.
 *
 * ## The race this closes
 *
 * A resource's "is it retired / does it have a future assignment" state can
 * change between `#131`'s `ELIGIBLE_RESOURCE_DIRECTORY` read (unlocked, by
 * design -- a read never writes and never blocks) and this transaction's own
 * `INSERT` into `booking_resource_assignments`, if a CONCURRENT transaction
 * retires that exact resource in between. Symmetrically, `business`'s
 * retire/close path can race a concurrent assignment being created for the
 * very resource it is about to retire. Neither side can see the other's
 * table (module boundary), so neither can take an ordinary row lock on it.
 *
 * A transaction-scoped advisory lock, keyed on `resourceId` and taken by
 * BOTH sides before their respective check-then-act, closes this: whichever
 * transaction locks a given resource id first, its counterpart on the other
 * side blocks until the first commits or rolls back, then observes the
 * post-commit truth rather than a stale read. This is the SAME technique
 * `wishlist.service.ts` (ADR-033 §8) and
 * `ServiceResourceRequirementService` (`#131`) already use for the identical
 * class of problem -- a check-then-act race over something that may not yet
 * (or may no longer) have a row to lock.
 *
 * ## Exported so both sides use the IDENTICAL derivation
 *
 * `booking`'s own assignment-creation path (`booking.service.ts`) and
 * `business`'s retire/close port adapter (`apps/api`, answering
 * `RESOURCE_ASSIGNMENT_DIRECTORY`) both call this exact function. Two
 * independent re-implementations of "hash this the same way" is exactly the
 * kind of drift that would silently reopen the race.
 */
export async function lockResourceForAssignment(manager: EntityManager, resourceId: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [RESOURCE_ASSIGNMENT_LOCK_NAMESPACE, resourceId]);
}
