import type { ChatCounterpartyType } from '@beauclick/chat-contract';

/**
 * The two seams `chat` reaches other domains through.
 *
 * `chat` may depend on `scope:shared` and nothing else (ADR-011, enforced by
 * lint), so each of these is declared here and **bound in the composition root**,
 * which is the only place a cross-domain read is permitted. `ChatModule` provides
 * none of them: a module that cannot boot without its ports bound is a module
 * whose boundary is real, because there is no default to fall back on.
 *
 * Read this file as the enforcement of `V32-DEC-010` and `V32-DEC-011`. Every
 * fact chat uses to decide who may talk to whom arrives through one of the two
 * interfaces below, and each returns a closed, structured value.
 */

/**
 * One qualifying booking relationship, already proven.
 *
 * The port returns only relationships that **qualify** — the eligibility rule
 * lives on the implementing side, next to the booking data it reads, rather than
 * being reconstructed here from raw statuses. That keeps `chat` from growing a
 * second opinion about what a booking status means.
 */
export interface ChatEligibleRelationship {
  /**
   * The counterparty **as it was at checkout**, from
   * `commerce.orders.seller_party_type/seller_party_id`.
   *
   * Never the current `SellerPartyLookup` answer. ADR-031 §1: a fallback to
   * current affiliation would fire exactly when the data is least trustworthy,
   * and would let a professional changing salon move an existing conversation to
   * a business the customer never dealt with.
   */
  readonly counterpartyType: ChatCounterpartyType;
  readonly counterpartyId: string;
  /**
   * `MAX(booking.slot_end)` across qualifying bookings with this counterparty.
   *
   * `slot_end` and not `completed_at`, because `completed_at` is null for
   * `cancelled` and `no_show` — both of which qualify — and measuring from it
   * would leave those two with an undefined send window.
   */
  readonly lastQualifyingSlotEnd: Date;
}

/**
 * Booking eligibility, implemented in the composition root over `booking` and
 * `commerce`.
 *
 * The whole of `V32-DEC-011` lives behind this interface:
 *
 * - `confirmed`, `completed`, and `no_show` qualify outright;
 * - `cancelled` qualifies **only** when `booking.booking_history` proves the
 *   booking previously reached `confirmed`;
 * - `pending` and `expired` never qualify;
 * - a refund never removes eligibility once prior confirmation is proven;
 * - a booking whose commerce order carries no seller snapshot **fails closed**
 *   and is simply absent from the results.
 */
export interface ChatEligibilityPort {
  /**
   * Every counterparty this customer may hold a conversation with, right now.
   *
   * Returns an empty array rather than throwing when there are none — "you have
   * no qualifying relationships" is an ordinary answer, not an error.
   */
  eligibleCounterpartiesFor(customerUserId: string): Promise<readonly ChatEligibleRelationship[]>;

  /**
   * The relationship with one specific counterparty, or null.
   *
   * Called inside the send transaction on every message (`V32-DEC-012`). A
   * conversation row existing is never evidence of eligibility, so this is
   * re-evaluated rather than cached — the moment a stored row can authorize a
   * send is the moment the window stops meaning anything.
   */
  findRelationship(
    customerUserId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<ChatEligibleRelationship | null>;
}

export const CHAT_ELIGIBILITY = Symbol('BEAUCLICK_CHAT_ELIGIBILITY');

/**
 * Who may read and write on the SELLER side of a conversation.
 *
 * `V32-DEC-010`, as corrected by the owner: for an independent professional it is
 * the professional's owning user; for a business it is the **owner and active
 * managers only**.
 *
 * Ordinary `staff` get nothing — including the practitioner who actually
 * delivered the service, when their role is only `staff`. `business_staff.role`
 * is `manager | staff` and nothing finer, so an any-active-staff rule would hand
 * a private customer conversation to everyone a salon has ever added. The
 * practitioner-specific grant that would fix this properly needs the V3.3-C role
 * matrix, which does not exist.
 */
export interface ChatSellerAccessPort {
  /**
   * True when this user may currently act on the seller side of a conversation
   * with this counterparty.
   *
   * Evaluated per request, never stored. A staff member deactivated this morning
   * loses the inbox on their next request, not at token expiry.
   */
  canAccessCounterparty(
    userId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<boolean>;

  /**
   * Every counterparty this user may currently act for.
   *
   * Drives the seller-side inbox. An empty array is the normal answer for a
   * customer with no professional or business role.
   */
  counterpartiesFor(userId: string): Promise<readonly { counterpartyType: ChatCounterpartyType; counterpartyId: string }[]>;

  /**
   * Who to notify on the seller side when a customer sends a message.
   *
   * Returns user ids, so `MessageSent` can carry a concrete `recipientUserId`
   * and the notification consumer needs no cross-domain join at dispatch time.
   * For a business this is the owner plus active managers; a message to a busy
   * salon notifies each of them once.
   */
  recipientsFor(
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<readonly string[]>;
}

export const CHAT_SELLER_ACCESS = Symbol('BEAUCLICK_CHAT_SELLER_ACCESS');

/**
 * There is deliberately NO notification port here.
 *
 * An earlier draft declared one, and it was redundant: `MessageSent` already
 * carries `recipientUserId`, and the platform's existing notification-rules
 * engine (`NOTIFICATION_RULES` in the composition root) maps an event to a
 * notification without any domain calling a channel or a service.
 *
 * Keeping the port would have meant two paths to the same notification -- the
 * rule and the direct call -- which is how a message ends up delivered twice, or
 * delivered by whichever path somebody remembered to keep working. The domain
 * emits a fact; the notification module decides what to do about it. That is
 * ADR-011's rule and it needs no seam of chat's own.
 */
