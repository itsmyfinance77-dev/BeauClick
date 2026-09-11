import type { EntityManager } from 'typeorm';
import type { BookingCollectionPolicySnapshotV1 } from '@beauclick/commercial-policy-contract';

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
  /**
   * The offering and its seller of record, read through the CALLER's
   * transaction — V3.3 #115 (`#41d-2b`), ADR-048 R3.
   *
   * ## Why the manager became mandatory
   *
   * It used to read on the adapter's injected repository connection, which is a
   * different connection from the one creating the order. The price and the
   * seller party were therefore selected outside the transaction that writes
   * them, so an offering edited or a staff affiliation changed in between
   * produced an order whose seller and price came from two different moments.
   *
   * ## What one manager does and does NOT guarantee
   *
   * It means one transaction and one connection, and it removes every
   * out-of-transaction read from this path. It does **not** create a single
   * immutable snapshot across statements: PostgreSQL's default `READ COMMITTED`
   * gives each statement a fresh snapshot, and this story deliberately does not
   * raise the isolation level. The guarantee that matters is elsewhere and is
   * structural — the seller party is selected ONCE, here, and passed forward
   * verbatim, so nothing later re-reads it and no two reads can disagree.
   */
  findServiceOffering(manager: EntityManager, serviceId: string): Promise<ServiceOfferingSnapshot | null>;
}

export const SERVICE_CATALOG = Symbol('BEAUCLICK_SERVICE_CATALOG');

/**
 * What the runtime resolver decided for one seller party — V3.3 #115
 * (`#41d-2b`), ADR-048 R4.
 *
 * A closed union of exactly two members, and the absence of a third is the
 * point. There is no `unavailable`, no `degraded` and no snapshot-with-a-null
 * inside: once a party is enrolled, a resolution that cannot produce a
 * validated snapshot must THROW rather than return a value the caller could
 * accidentally treat as "carry on". `V33-DEC-029` Ruling 8 forbids a
 * post-lookup fallback, and a nullable third state is how one gets added by
 * accident six months later.
 *
 * `legacy_unenrolled` means the party has no current assignment row. Presence
 * IS enrollment (ADR-048 R2), so its absence is a first-class, permanent answer
 * and not an error.
 */
export type ResolvedBookingCollectionPolicy =
  | { readonly outcome: 'legacy_unenrolled' }
  | { readonly outcome: 'enrolled'; readonly snapshot: BookingCollectionPolicySnapshotV1 };

/**
 * "Which collection policy governs this seller party's booking, right now?"
 * — V3.3 #115 (`#41d-2b`), ADR-048 R4.
 *
 * ## Commerce owns the question; `apps/api` answers it
 *
 * Declared here for the reason `ServiceCatalog` above is: ADR-011 forbids
 * `services/commerce` importing `services/commercial-policy`, and
 * `scope:commerce` may depend only on `scope:shared`. The snapshot type crosses
 * the boundary because `@beauclick/commercial-policy-contract` is a
 * browser-safe `scope:shared` package with no ORM entity and no service in it —
 * the same package this module's own schedule entity already imports
 * `BookingCollectionMode` from.
 *
 * ## What this port deliberately cannot be asked
 *
 * It takes the seller party Commerce has ALREADY selected, and nothing else.
 * There is no `userId`, no `workspaceRef`, no `policyKey` and no
 * `policyVersion` parameter — not validated-and-rejected, **absent**. A caller
 * cannot name the policy it wants, cannot ask on behalf of another identity,
 * and cannot pin a version. Those would each be a way to put terms on a booking
 * that the seller's own assignment did not choose.
 *
 * ## The manager is mandatory, and not optional
 *
 * Resolution reads the assignment and the version row that will price the
 * order, and locks both. On a different connection from the one writing the
 * order, an administrator retiring a version or a seller superseding an
 * assignment between the read and the insert would give a booking terms it was
 * never offered — and no constraint could catch it, because every row would be
 * individually valid. That is the same reasoning `PriceResolutionService`
 * records for taking its manager as a parameter.
 *
 * There is deliberately no default and no `@Optional()` overload: an optional
 * manager is an out-of-transaction read that nothing would report.
 */
export interface BookingCollectionPolicyResolver {
  /**
   * @param manager the caller's transaction. Every read and every lock must use
   *   it; a read on another connection is outside the transaction that decides
   *   whether this order exists at all.
   * @param sellerParty the party Commerce already selected from the service
   *   offering, passed forward verbatim. Never re-derived, never client-supplied.
   */
  resolveForSellerParty(
    manager: EntityManager,
    sellerParty: OrderSellerParty,
  ): Promise<ResolvedBookingCollectionPolicy>;
}

/** The seller of record an order is being created for. The port's whole input besides the manager. */
export interface OrderSellerParty {
  readonly partyType: 'professional' | 'business';
  readonly partyId: string;
}

export const BOOKING_COLLECTION_POLICY_RESOLVER = Symbol('BEAUCLICK_BOOKING_COLLECTION_POLICY_RESOLVER');

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
  | { outcome: 'ineligible'; reason: 'no_order' | 'no_subscription' }
  /*
   * V3.3 #95 (`#58b-1`), ADR-050 §4.3 -- ADDITIVE. The control plane refused
   * the confirmation. Nothing was consumed. Every member above is
   * byte-identical to #58a's, and a caller treats this exactly as it treats
   * `insufficient_credit`: the zero-collectible path rolls back, the
   * verified-capture path keeps the capture and refunds. The reason is an
   * internal vocabulary that never reaches a client (ADR-050 §9):
   *
   *   `kill_switch_active`       -- #95: the emergency switch is engaged;
   *                                 refused before the ledger was consulted.
   *   `business_policy_disabled` -- #141 (`#58b-2`): the rollout is active
   *                                 and the order's party has no governance
   *                                 decision; refused before the ledger.
   *   `entitlement_missing`      -- #141: the party is governed under an
   *                                 active rollout and the ledger answered
   *                                 `not_configured` or `insufficient_credit`.
   */
  | { outcome: 'control_refused'; reason: 'kill_switch_active' | 'business_policy_disabled' | 'entitlement_missing' };

export const BOOKING_CONFIRMATION_ENTITLEMENT_HOOK = Symbol('BEAUCLICK_BOOKING_CONFIRMATION_ENTITLEMENT_HOOK');
