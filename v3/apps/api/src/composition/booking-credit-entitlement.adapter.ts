import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { OrderEntity } from '@beauclick/commerce';
import type { BookingConfirmationEntitlementHook, BookingConfirmationEntitlement } from '@beauclick/commerce';
import {
  BookingCreditAccountingService,
  BookingCreditReturnCause,
} from '@beauclick/commercial-policy';

/**
 * The entitlement seam's real binding — V3.3 #58 (`#58a`), ADR-046 §3 and §7.
 *
 * Replaces #81's no-op. `services/commerce` declares the port and
 * `services/commercial-policy` owns the ledger; ADR-011 forbids either importing
 * the other, so the join happens here in `apps/api`, which is the one scope
 * permitted to see both.
 *
 * ## Why this adapter resolves the party rather than the ledger
 *
 * The charged party is a **commerce** fact — the order's immutable
 * `sellerPartyType`/`sellerPartyId`, written at order creation and therefore
 * fixed before either confirmation path runs. The commercial service must not
 * reach into `commerce.orders` to find it, and the port must not accept it from
 * a caller, so this adapter is exactly where the translation belongs.
 *
 * Live `business_staff` affiliation is never consulted. `V33-DEC-020`
 * established the rule for finance reads and `V33-DEC-025` Ruling 7 restates it
 * for credits: current affiliation must not decide historical money.
 */
@Injectable()
export class BookingCreditEntitlementAdapter implements BookingConfirmationEntitlementHook {
  constructor(private readonly credits: BookingCreditAccountingService) {}

  async onBookingConfirmation(
    manager: EntityManager,
    bookingId: string,
  ): Promise<BookingConfirmationEntitlement> {
    /*
     * Exactly one order, found by the booking it was created for. The unique
     * index on `(source_type, source_id)` makes "exactly one" a storage
     * guarantee rather than an assumption, and an absent order fails closed:
     * charging some other party would be worse than refusing.
     */
    const order = await manager.findOne(OrderEntity, {
      where: { sourceType: 'booking', sourceId: bookingId },
    });
    if (!order) return { outcome: 'ineligible', reason: 'no_order' };

    const result = await this.credits.consumeForConfirmation(manager, bookingId, {
      partyType: order.sellerPartyType,
      partyId: order.sellerPartyId,
    });

    switch (result.outcome) {
      case 'consumed':
      case 'already_consumed':
      case 'not_configured':
        return { outcome: 'permitted', detail: result.outcome };
      case 'insufficient_credit':
        return { outcome: 'insufficient_credit' };
      default:
        return { outcome: 'ineligible', reason: result.reason };
    }
  }
}

/**
 * The cancellation half — V3.3 #58 (`#58a`), ADR-046 §8.
 *
 * Bound to booking-service's own port so the return is written **inside the
 * cancellation's transaction**: a cancellation that rolls back leaves no return,
 * and a return that fails rolls back the cancellation. No event, no eventual
 * consumer, no window in which a credit is owed but unrecorded.
 *
 * ## The actor mapping is the policy boundary, and it is narrow on purpose
 *
 * Only two actors are both reachable and already authorised. `customer`
 * cancellation is deliberately absent: whether it returns the seller's credit is
 * retention policy under `V33-DEC-013` and #46, and answering it here would be
 * inventing commercial policy in an adapter. `admin` is absent because no
 * production route produces that actor, and `business` because the booking actor
 * vocabulary has no such value.
 */
@Injectable()
export class BookingCreditCancellationAdapter {
  constructor(private readonly credits: BookingCreditAccountingService) {}

  async onBookingCancellation(
    manager: EntityManager,
    bookingId: string,
    actorType: string,
    wasConfirmed: boolean,
  ): Promise<void> {
    // A booking that was never confirmed consumed nothing, so there is nothing
    // to give back. An expired pending hold reaches here and correctly does
    // nothing.
    if (!wasConfirmed) return;

    const cause = CAUSE_BY_ACTOR[actorType];
    if (!cause) return;

    await this.credits.returnForCancellation(manager, bookingId, cause);
  }
}

/** The closed mapping. Absent actors return nothing rather than defaulting. */
const CAUSE_BY_ACTOR: Record<string, BookingCreditReturnCause | undefined> = {
  professional: 'seller_cancelled',
  system: 'platform_cancelled',
};
