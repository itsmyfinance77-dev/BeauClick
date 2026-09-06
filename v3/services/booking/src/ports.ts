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
