import type { EntityManager } from 'typeorm';

/**
 * commerce-service's outbound ports.
 *
 * Same rationale as booking-service's: ADR-011 forbids `services/commerce`
 * importing `services/provider`, yet an order's price must come from the
 * professional's real service catalogue. The port is declared here and
 * implemented in `apps/api`.
 *
 * Note what the port deliberately does NOT offer: any way for a caller to
 * SUPPLY a price. The only price-shaped thing that crosses this boundary is
 * one the catalogue itself reports.
 */
export interface ServiceOfferingSnapshot {
  id: string;
  professionalId: string;
  name: string;
  priceToman: number;
  durationMinutes: number;
  /**
   * Phase 4 (ADR-023 §3): the real seller of record for this offering.
   * `professionalId` above never changes meaning -- it still identifies
   * whose calendar/booking this is. `sellerPartyId` is who the money is
   * FOR: the professional themselves when independent, or the business
   * when that professional is an active staff member of one. Order
   * creation copies these two fields verbatim rather than re-deriving
   * "professional" on its own, so this port is the single place that
   * decision is made.
   */
  sellerPartyType: 'professional' | 'business';
  sellerPartyId: string;
}

export interface ServiceCatalog {
  findServiceOffering(serviceId: string): Promise<ServiceOfferingSnapshot | null>;
}

export const SERVICE_CATALOG = Symbol('BEAUCLICK_SERVICE_CATALOG');

/**
 * The entitlement seam every booking confirmation passes through —
 * V3.3 #58 (`#58a`), ADR-046 §3, `V33-DEC-025` Ruling 3.
 *
 * ## Renamed in #58a, and the old name was the bug
 *
 * It was `ZeroCollectibleConfirmationHook`, introduced by #81 (ADR-044 §6) and
 * called from the zero-collectible path alone. #82 then added a second
 * confirmation path that never entered it, so "one credit at first
 * `confirmed`" was unsatisfiable by construction. The name was accurate and
 * the coverage was not; both are corrected here.
 *
 * ## Why it exists before anything needs it
 *
 * #58 consumes a booking credit at the moment a booking is first confirmed, and
 * that consumption must commit with the confirmation or not at all. Building the
 * seam now — with a no-op behind it — means #58 replaces one binding in the
 * composition root and touches no booking, commerce or payment code.
 *
 * ## Why it is mandatory rather than `@Optional()`
 *
 * An optional entitlement dependency is a money effect that can be silently
 * absent. Nothing in the response, the logs or the tests would say so; the
 * booking would confirm and the credit would simply never be spent. So the
 * binding is required, a composition that omits it fails to construct at boot,
 * and there is no default value, no optional chaining at the call site and no
 * catch-and-ignore.
 *
 * ## Why the booking id is the only identifier
 *
 * This is a security boundary, not an ergonomic one. A caller-supplied owner,
 * party, subject or quantity on an entitlement seam is a grant of somebody
 * else's credits, chosen by the caller. The implementation resolves everything
 * it needs from the booking itself.
 */
export interface BookingConfirmationEntitlementHook {
  /**
   * Runs inside the confirmation transaction, between the order transition and
   * the booking confirmation (ADR-044 §3).
   *
   * Returns a closed outcome rather than throwing for an ordinary refusal:
   * "this seller has no credit left" is routed differently on each
   * confirmation path -- the zero-collectible path rolls back, and the
   * verified-capture path must keep the money fact and refund it (ADR-046 §6).
   * Only a genuine fault throws.
   *
   * @param manager the caller's transaction. Every read and write must use it;
   *   anything on another connection is outside the transaction that is about
   *   to decide whether this booking exists at all.
   * @param bookingId the booking being confirmed, and the entire identity of
   *   the entitlement effect.
   */
  onBookingConfirmation(manager: EntityManager, bookingId: string): Promise<BookingConfirmationEntitlement>;
}

/**
 * What the entitlement layer decided -- V3.3 #58 (`#58a`), ADR-046 §2.
 *
 * `permitted` carries WHY it was permitted, because the three reasons are
 * operationally different: a credit was spent, this booking was already
 * charged, or this party has never been configured with one. The last is a
 * rollout state and never an unlimited allowance.
 */
export type BookingConfirmationEntitlement =
  | { outcome: 'permitted'; detail: 'consumed' | 'already_consumed' | 'not_configured' }
  | { outcome: 'insufficient_credit' }
  | { outcome: 'ineligible'; reason: 'no_order' | 'no_subscription' };

export const BOOKING_CONFIRMATION_ENTITLEMENT_HOOK = Symbol('BEAUCLICK_BOOKING_CONFIRMATION_ENTITLEMENT_HOOK');
