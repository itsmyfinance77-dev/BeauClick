import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { OrderEntity } from '@beauclick/commerce';
import type { OrderStatus } from '@beauclick/commerce';
import type { ReferralOrderFacts, ReferralOrderLookupPort } from '@beauclick/referral';

/**
 * The one order status that means **fully refunded** — V3.2-C Story #28
 * (`V32-DEC-017`, ADR-038 §2).
 *
 * ## Why a status and not an arithmetic comparison
 *
 * The obvious alternative is `refunded_total_toman >= total_toman`, computed
 * here. It is rejected because commerce already computes exactly that, in the
 * same statement that moves the money:
 *
 * ```sql
 * status = CASE WHEN refunded_total_toman + :amount >= total_toman
 *               THEN 'refunded' ELSE 'partially_refunded' END
 * ```
 *
 * Recomputing it in a second place would be a second implementation of one
 * rule, free to drift the first time either side changes — and this side would
 * drift silently, because a referral that failed to reverse looks exactly like
 * a referral that was never refunded.
 *
 * `cancelled` is **not** fully refunded and must not be: a cancelled order is
 * one that was never paid, so there is no reward it could have earned and
 * nothing to take back. The `satisfies` annotation means adding a status to
 * `ORDER_STATUSES` without deciding its meaning here is a **type error**, not a
 * default.
 */
const FULLY_REFUNDED = 'refunded' satisfies OrderStatus;

/**
 * The referral domain's one read into commerce (ADR-011, ADR-038 §3).
 *
 * ADR-011 forbids a domain importing another and lint enforces it: a
 * `@beauclick/commerce` import inside `services/referral` fails CI. `apps/api`
 * is `scope:app` and is the one place permitted to depend on every domain, so
 * this is where the cross-domain read is written down — exactly as
 * `ReferralIdentityAdapter` and `ReferralBookingAdapter` are.
 *
 * ## Both methods read the AUTHORITATIVE table and lock the row
 *
 * `PublicCatalogueAiAdapter`, `WishlistTargetAdapter` and `referral-ports.ts`
 * all record the same reasoning for reading authoritative tables rather than a
 * projection, and it transfers unchanged: a search projection is eventually
 * consistent, so it can still assert a fact the platform has just changed.
 * Here the consequence would be a stale "not refunded" answer leaving a reward
 * standing on a refunded order.
 *
 * The `FOR SHARE` lock is a **contract requirement**, not an optimisation, and
 * `ReferralOrderLookupPort` says so. It closes the one out-of-order interleaving
 * a re-read alone cannot (ADR-038 §8): a refund committing between the
 * qualification transaction's read and its commit, with the reversal handler's
 * compare-and-swap landing in the same window and seeing a still-pending
 * referral. `FOR SHARE` rather than `FOR UPDATE` because this is a read that
 * must not be invalidated, not a row this transaction intends to write — and a
 * shared lock lets two concurrent referral reads proceed while still blocking
 * the refund's `UPDATE`.
 *
 * No deadlock is possible: nothing in the refund path touches
 * `referral.referrals`, so the two transactions cannot form a cycle.
 *
 * ## Four fields cross this boundary, and the omissions are the design
 *
 * `customerId`, `sellerPartyType`, `sellerPartyId`, every amount, the currency
 * and the timestamps all stay on this side. The referral domain matches on the
 * booking and already knows both parties from its own row; an identity or a
 * money figure crossing here would be data it holds for no reason and one
 * careless log line from a payload `V32-DEC-033` forbids.
 *
 * `select` is therefore explicit rather than a bare `findOne`. The difference
 * is not performance: an entity load would pull the customer id and the totals
 * into the referral domain's call stack, where an exception serialiser or a
 * debug log could pick them up.
 */
@Injectable()
export class ReferralOrderAdapter implements ReferralOrderLookupPort {
  async findOrderById(manager: EntityManager, orderId: string): Promise<ReferralOrderFacts | null> {
    return this.load(manager, 'o.id = :orderId', { orderId });
  }

  async findBookingOrder(
    manager: EntityManager,
    bookingId: string,
  ): Promise<ReferralOrderFacts | null> {
    // `UNIQUE(source_type, source_id)` on `commerce.orders` -- the structural
    // fix for GAP-03 -- makes this an exact lookup rather than a search: a
    // booking has at most one order, so there is no ordering to pick from and
    // no "most recent" to get wrong.
    return this.load(manager, "o.sourceType = 'booking' AND o.sourceId = :bookingId", { bookingId });
  }

  /**
   * One query shape for both directions, so the projection and the lock cannot
   * differ between them.
   *
   * `getRawOne` with an explicit projection rather than `findOne`: a raw select
   * makes the four columns that cross the boundary a visible list rather than a
   * filter applied to a fully-loaded entity, so nothing else can arrive by
   * accident when the order gains a column.
   *
   * `setLock('pessimistic_read')` emits `FOR SHARE` and TypeORM **refuses it
   * outside a transaction**, which is a free enforcement of the port's other
   * requirement: an adapter that ignored the caller's manager and opened its
   * own connection would fail loudly here rather than silently returning an
   * unlocked read.
   */
  private async load(
    manager: EntityManager,
    where: string,
    params: Record<string, string>,
  ): Promise<ReferralOrderFacts | null> {
    const row = await manager
      .createQueryBuilder(OrderEntity, 'o')
      .select('o.id', 'id')
      .addSelect('o.sourceType', 'source_type')
      .addSelect('o.sourceId', 'source_id')
      .addSelect('o.status', 'status')
      .where(where, params)
      .setLock('pessimistic_read')
      .getRawOne<{ id: string; source_type: string; source_id: string; status: OrderStatus }>();

    // `null` rather than a throw. A refund for an order this process cannot see,
    // or a booking with no order at all, is nothing the referral domain can act
    // on -- and raising would poison an outbox row into retrying forever. The
    // domain folds both into "nothing to reverse".
    if (!row) return null;

    return {
      orderId: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      fullyRefunded: row.status === FULLY_REFUNDED,
    };
  }
}
