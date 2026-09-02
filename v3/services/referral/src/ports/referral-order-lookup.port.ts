import type { EntityManager } from 'typeorm';

/**
 * The referral domain's one reach into commerce — V3.2-C Story #28 (ADR-011,
 * ADR-038 §3).
 *
 * `referral` may not import `commerce` (ADR-011, enforced by
 * `@nx/enforce-module-boundaries`: a `@beauclick/commerce` import inside
 * `services/referral` fails CI). So it declares the narrowest thing it needs
 * and the composition root binds it — the same treatment
 * `REFERRAL_LOYALTY_PORT`, `REFERRAL_IDENTITY_PORT` and `REFERRAL_BOOKING_PORT`
 * all get.
 *
 * ## Why this port has to exist at all
 *
 * `OrderRefunded` v1's payload is
 * `{orderId, refundId, refundAmountToman, refundedTotalToman, currency, refundedAt}`
 * — **no `customerId`, no `sourceType`, no `sourceId`**. A reversal handler
 * holding only that cannot tell which booking, and therefore which referral, a
 * refund concerns. There is no field to widen it into either: a payload change
 * is a **new version, never an edit** (ADR-022), so widening v1 would silently
 * redefine a contract `OrderRefundedLedgerHandler` is already parsing.
 *
 * ## Why the answer is re-read rather than taken from the event
 *
 * `V32-DEC-017` reverses on a **FULL** refund and never on a partial one, and
 * the event cannot distinguish them: `recordRefund` emits the same event for
 * both, and a sequence of partials eventually becomes a full refund whose final
 * event looks exactly like the ones that did not. The order's **status** is the
 * platform's own authoritative answer, computed by the database in the same
 * statement that moved the money — so this port asks for that answer instead of
 * recomputing a rule that already has one implementation.
 *
 * ## What it deliberately cannot answer
 *
 * It reports four facts and refuses several that would be easy to add.
 *
 * **No customer id.** The order has one and the referral domain has no use for
 * it: the referral row already names both parties, and the match is made on the
 * booking. An identity crossing this boundary for no reason is one careless log
 * line from a payload `V32-DEC-033` forbids.
 *
 * **No amounts, no currency, no seller party.** Money detail has no business in
 * a referral handler, and there is no method here that could return it, so no
 * caller can construct one.
 *
 * **No duplicate-charge flag**, and this is a finding rather than an omission
 * (ADR-038 §3). `RefundCompletedCommerceHandler` returns before calling
 * `recordRefund` for a duplicate charge, and that handler is
 * `OrderService.recordRefund`'s only production caller — so a duplicate-charge
 * correction never moves an order's status and `fullyRefunded` is already false
 * for it, permanently. A field reporting it would be a guard that can never
 * fire, which reads to the next author as though the danger were handled
 * somewhere and invites them to rely on it. The exclusion is proved end to end
 * instead.
 */

/**
 * The four facts the referral domain needs about a booking's order.
 *
 * `sourceType` and `sourceId` are returned even though the lookup is BY booking
 * id, and that is deliberate: the caller asserts they match the referral's own
 * `qualifying_booking_id` before reversing anything, so an adapter that ever
 * resolved the wrong order is caught by the domain rather than trusted. A port
 * whose contract is "I return the right row" is a port nothing checks.
 */
export interface ReferralOrderFacts {
  readonly orderId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  /**
   * Whether the order is **fully** refunded, from its authoritative status.
   *
   * A boolean rather than the status string, because the referral domain has no
   * business knowing that `partially_refunded`, `cancelled` and `paid` are
   * different things. It asks one question and gets one answer, and the mapping
   * from statuses to that answer lives in the one module that owns order
   * statuses.
   */
  readonly fullyRefunded: boolean;
}

export interface ReferralOrderLookupPort {
  /**
   * The order with this id, or `null`.
   *
   * The **reversal** direction. `OrderRefunded` carries an order id and nothing
   * else usable, so this is where a refund becomes a booking: the returned
   * `sourceId` is the booking the order was produced for, which is what
   * `referral.referrals.qualifying_booking_id` is matched against.
   *
   * Locked `FOR SHARE`, like its sibling, and `null` is a normal return.
   */
  findOrderById(manager: EntityManager, orderId: string): Promise<ReferralOrderFacts | null>;

  /**
   * The order this booking produced, or `null` when there is none.
   *
   * The **convergence** direction (ADR-038 §8): the qualification transaction
   * asks whether the booking it has just qualified already belongs to a fully
   * refunded order. `commerce.orders` carries `UNIQUE(source_type, source_id)`,
   * so a booking has at most one order and this is an exact lookup rather than
   * a search.
   *
   * `null` is a **normal** return value. A booking with no order is an ordinary
   * state — a zero-total booking, or a test fixture qualifying a referral
   * without a commerce order behind it — and the caller treats it as "nothing
   * to reverse" rather than as an error. Raising here would turn an unremarkable
   * shape into a poisoned outbox row retrying forever.
   *
   * ## The row is locked `FOR SHARE`, and that is part of the contract
   *
   * Not an implementation detail the adapter may drop. It closes the one
   * out-of-order interleaving a re-read alone cannot (ADR-038 §8): a refund
   * that commits *between* the qualification transaction's read of the order
   * and its own commit, with the reversal handler's compare-and-swap landing in
   * the same window and seeing a referral that is still pending. Both paths
   * would miss, and a fully refunded order would keep an active referral
   * reward — `V32-DEC-017`'s free-points loop, reintroduced by delivery order.
   *
   * With the share lock the window is unrepresentable: either the qualification
   * locks first and the refund's `UPDATE` waits, or the refund commits first and
   * the qualification reads a fully refunded order. No deadlock is possible,
   * because the refund path never touches `referral.referrals`.
   *
   * ## The manager is not optional
   *
   * The fact gates a write and must be read by the transaction performing it; a
   * fact read on another connection is a fact that can change between the read
   * and the write, and the lock would be released immediately besides. It is
   * also the connection-exhaustion defect V3.2-B recorded as **bug #2**, where a
   * port opening its own connection inside a caller's transaction needed 2N
   * connections against a pool of 10.
   */
  findBookingOrder(manager: EntityManager, bookingId: string): Promise<ReferralOrderFacts | null>;
}

export const REFERRAL_ORDER_LOOKUP_PORT = Symbol('BEAUCLICK_REFERRAL_ORDER_LOOKUP_PORT');
