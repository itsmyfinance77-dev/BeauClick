import { Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope, AuditLogger } from '@beauclick/events';
import { LedgerService } from '@beauclick/financial';
import { OrderService } from '@beauclick/commerce';
import { PaymentService } from '@beauclick/payment';
import { BookingService } from '@beauclick/booking';

/**
 * The Phase 2 event graph, in one file so the whole reaction chain is
 * readable at once:
 *
 *   OrderPaid        -> record commission + receivable in the ledger
 *   RefundCompleted  -> record the refund against the order
 *   OrderRefunded    -> reverse the ledger at the ORIGINAL captured rate
 *   BookingCancelled -> refund the linked order if it was paid
 *   BookingExpired   -> cancel the unpaid order
 *
 * Every handler is idempotent, because the outbox guarantees at-least-once
 * delivery and never exactly-once. Each one says below what makes it so --
 * a real database constraint or a status compare-and-swap, never "it
 * probably won't be delivered twice".
 *
 * Note the direction of every arrow: booking-service fires facts and never
 * decides financial consequences; commerce and payment decide those. That is
 * V2's separation of concerns, preserved deliberately -- inverting it would
 * put refund policy inside the scheduling domain.
 */

@Injectable()
export class OrderPaidLedgerHandler implements DomainEventHandler {
  readonly eventType = 'OrderPaid';
  private readonly logger = new Logger('OrderPaidLedgerHandler');

  constructor(
    private readonly ledger: LedgerService,
    private readonly payments: PaymentService,
  ) {}

  /**
   * Consumes `OrderPaid` rather than `PaymentSucceeded` on purpose: the
   * commerce event already carries the seller party and the authoritative
   * total, so the ledger never has to re-derive who earns what. It also
   * means the ledger reacts to "the order is paid" -- the business fact --
   * rather than to a gateway-level detail.
   *
   * Idempotent via `UNIQUE(entry_type, reference_type, reference_id)` on the
   * ledger: a redelivery inserts zero rows and returns false.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as {
      orderId: string;
      sourceType: string;
      sourceId: string;
      sellerPartyType: 'professional' | 'business';
      sellerPartyId: string;
      totalToman: number;
    };

    // The payment intent id is the ledger's reference, so the ledger entry is
    // tied to the specific payment that produced it -- not merely to the
    // order, which could in principle be paid by a later attempt.
    const intent = await this.payments.findLiveIntentForOrder(payload.orderId);
    if (!intent) {
      // A zero-total order legitimately has no intent to reference. Anything
      // else means the events arrived out of order; leaving it unpublished
      // lets the sweep retry once the intent exists.
      if (payload.totalToman === 0) return;
      throw new Error(`No payment intent found for paid order ${payload.orderId}`);
    }

    const recorded = await this.ledger.recordPayment({
      orderId: payload.orderId,
      sourceId: payload.sourceType === 'booking' ? payload.sourceId : null,
      sellerPartyType: payload.sellerPartyType,
      sellerPartyId: payload.sellerPartyId,
      netAmountToman: payload.totalToman,
      paymentReferenceId: intent.id,
    });

    if (!recorded) {
      this.logger.debug(`Ledger already recorded payment for order ${payload.orderId} -- idempotent no-op`);
    }
  }
}

@Injectable()
export class RefundCompletedCommerceHandler implements DomainEventHandler {
  readonly eventType = 'RefundCompleted';

  constructor(private readonly orders: OrderService) {}

  /**
   * payment-service reports that money genuinely went back; commerce records
   * it against the order, which in turn emits `OrderRefunded` for the ledger.
   *
   * Deliberately a separate listener from the code that ISSUES the refund --
   * V2's "listen to the fact, not the intent" discipline. The ledger must
   * react to a refund that actually happened, never to one we merely asked
   * for.
   *
   * Idempotent: `recordRefund` compare-and-swaps on the order's refundable
   * statuses and the `refunded_total + amount <= total` predicate, so a
   * redelivery affects zero rows.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as {
      refundId: string;
      orderId: string;
      amountToman: number;
      kind?: 'order' | 'duplicate_charge';
    };

    // A duplicate-charge correction is money that was never part of this
    // order's accounting -- the order was legitimately paid once. Recording
    // it here would drive a correctly-paid order to `refunded` and reverse a
    // commission the professional genuinely earned.
    if (payload.kind === 'duplicate_charge') return;

    const order = await this.orders.findById(payload.orderId);
    if (!order) return;

    // Guard the redelivery case explicitly: without it, a second delivery
    // would attempt a second increment and (correctly) be rejected by the
    // CHECK constraint -- but as a thrown error rather than a quiet no-op,
    // which would keep the row un-published and retry forever.
    const alreadyCounted = order.refundedTotalToman >= order.totalToman;
    if (alreadyCounted) return;

    await this.orders.recordRefund(payload.orderId, payload.amountToman, payload.refundId);
  }
}

@Injectable()
export class OrderRefundedLedgerHandler implements DomainEventHandler {
  readonly eventType = 'OrderRefunded';

  constructor(private readonly ledger: LedgerService) {}

  /**
   * Reverses the ledger at the ORIGINAL captured commission rate, never the
   * platform's current one -- `LedgerService.recordRefund` reads the rate off
   * the original entry. Idempotent via the same unique constraint, keyed on
   * the refund id.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { orderId: string; refundId: string; refundAmountToman: number };
    await this.ledger.recordRefund({
      orderId: payload.orderId,
      refundId: payload.refundId,
      refundAmountToman: payload.refundAmountToman,
    });
  }
}

@Injectable()
export class BookingCancelledRefundHandler implements DomainEventHandler {
  readonly eventType = 'BookingCancelled';
  private readonly logger = new Logger('BookingCancelledRefundHandler');

  constructor(
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
  ) {}

  /**
   * A cancelled booking whose order was already paid gets its money back.
   *
   * This closes V2's FIN-02 gap by construction: there, the customer-facing
   * cancel path did not trigger a refund at all for an already-paid booking
   * until it was found in an audit. Here the refund is a consequence of the
   * cancellation event itself, so no cancellation path can be added later
   * that forgets it.
   *
   * Refunds the order's real REMAINING refundable amount, recomputed from the
   * order every time -- never an independently tracked figure. Correct
   * whether this is the first refund or a second, and correct regardless of
   * any discount already reflected in the total.
   *
   * Idempotent on `UNIQUE(order_id, request_key)` with a request key derived
   * from the booking id.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { bookingId: string };

    const detail = await this.orders.findBySource('booking', payload.bookingId);
    if (!detail) return;

    const order = detail.order;
    if (order.status === 'pending') {
      // Never paid -- nothing to refund. Cancel the order so it stops
      // appearing as awaiting payment.
      await this.orders.cancel(order.id, `booking_cancelled:${payload.bookingId}`);
      return;
    }

    const remaining = this.orders.remainingRefundable(order);
    if (remaining <= 0) return;

    await this.payments.refund({
      orderId: order.id,
      amountToman: remaining,
      reason: 'رزرو مرتبط لغو شد — بازگشت خودکار وجه.',
      requestKey: `booking-cancelled:${payload.bookingId}`,
      actorType: 'system',
      actorId: null,
    });

    this.logger.log(`Refund issued for cancelled booking ${payload.bookingId} (order ${order.id}, ${remaining} Toman)`);
  }
}

@Injectable()
export class BookingExpiredOrderHandler implements DomainEventHandler {
  readonly eventType = 'BookingExpired';

  constructor(private readonly orders: OrderService) {}

  /**
   * An abandoned hold's order is cancelled so it stops showing as awaiting
   * payment. `cancel()` only touches a `pending` order, so an order that was
   * in fact paid just as the hold lapsed is left alone -- that case is the
   * paid-but-unconfirmable path's responsibility, not this one's.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { bookingId: string };
    const detail = await this.orders.findBySource('booking', payload.bookingId);
    if (!detail) return;
    await this.orders.cancel(detail.order.id, `booking_expired:${payload.bookingId}`);
  }
}

/** Registered so the relay can see it; booking-service owns the transition itself. */
@Injectable()
export class BookingConfirmedLogHandler implements DomainEventHandler {
  readonly eventType = 'BookingConfirmed';
  private readonly logger = new AuditLogger('booking');

  constructor(private readonly bookings: BookingService) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { bookingId: string };
    const booking = await this.bookings.findById(payload.bookingId);
    this.logger.log({ action: 'booking.confirmed.observed', bookingId: payload.bookingId, status: booking?.status });
  }
}
