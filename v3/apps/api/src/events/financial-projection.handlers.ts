import { Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope, AuditLogger } from '@beauclick/events';
import { FundJournalService, LedgerService } from '@beauclick/financial';
import { OrderService } from '@beauclick/commerce';
import { PaymentService } from '@beauclick/payment';
import { BookingService } from '@beauclick/booking';

import { BookingOutcomeOrchestrator } from '../outcome/booking-outcome.orchestrator';

/**
 * The Phase 2 event graph, in one file so the whole reaction chain is
 * readable at once:
 *
 *   OrderPaid        -> post a `collection` journal (`FundJournalService`)
 *   RefundCompleted  -> record the refund against the order
 *   OrderRefunded    -> reverse against whichever regime this order's
 *                       collection actually lives in (see the router note
 *                       on `OrderRefundedLedgerHandler` below)
 *   BookingCancelled -> refund the linked order if it was paid, cancel it if
 *                       BeauClick never collected for it (V3.3 #81)
 *   BookingExpired   -> cancel the uncollected order
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
 *
 * ## `#43a` (ADR-052 §16): every order collected from this deploy is the NEW
 * regime, unconditionally
 *
 * `OrderPaidLedgerHandler`/`OrderCollectionCapturedLedgerHandler` used to
 * call `LedgerService.recordPayment`, which posted a commission + receivable
 * pair at the platform's then-current rate. `recordPayment` and the in-code
 * rate it read are REMOVED (ADR-052 §16), not merely bypassed: every new
 * collection now posts a balanced `collection` journal through
 * `FundJournalService` instead, carrying no commission and no receivable at
 * all (neither commission policy nor release exist until `#43b`/`#43c`).
 * There is no branch here because there is no legacy path left to choose for
 * a COLLECTION -- only a refund can land against an order that collected
 * before this deploy, which is what `OrderRefundedLedgerHandler`'s router
 * decides.
 */

@Injectable()
export class OrderPaidLedgerHandler implements DomainEventHandler {
  /**
   * Annotated `string`, matching `DomainEventHandler`, rather than left to
   * infer the literal `'OrderPaid'` — otherwise the #82 subclass below cannot
   * declare its own event name.
   */
  readonly eventType: string = 'OrderPaid';
  private readonly logger = new Logger('OrderPaidLedgerHandler');

  constructor(
    private readonly fundJournal: FundJournalService,
    private readonly payments: PaymentService,
  ) {}

  /**
   * Consumes `OrderPaid` rather than `PaymentSucceeded` on purpose: the
   * commerce event already carries the seller party and the authoritative
   * total, so the journal never has to re-derive who earns what. It also
   * means it reacts to "the order is paid" -- the business fact -- rather
   * than to a gateway-level detail.
   *
   * Idempotent via `uq_fund_journals_idempotency_key` on
   * `collection:<paymentIntentId>`: a redelivery writes zero rows and
   * returns false.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as {
      orderId: string;
      sourceType: string;
      sourceId: string;
      sellerPartyType: 'professional' | 'business';
      sellerPartyId: string;
      /** `OrderPaid v1` — the whole service total, which it also collected. */
      totalToman?: number;
      /** `OrderCollectionCaptured v1` — the only money BeauClick holds. */
      platformCollectedToman?: number;
    };

    /*
     * V3.3 #82 (ADR-045 §6). The ledger records COLLECTED money, whichever
     * event carried it.
     *
     * For `OrderPaid` the collected amount IS the service total, so full-online
     * ledger behaviour is byte-identical to before. For
     * `OrderCollectionCaptured` it is the platform-collected figure and the
     * venue balance is deliberately absent from this payload's reach: the
     * event carries `venueBalanceToman`, and nothing here reads it, because it
     * is money BeauClick neither holds nor is owed.
     */
    const collectedToman = payload.platformCollectedToman ?? payload.totalToman ?? 0;

    // The payment intent id is the ledger's reference, so the ledger entry is
    // tied to the specific payment that produced it -- not merely to the
    // order, which could in principle be paid by a later attempt.
    const intent = await this.payments.findLiveIntentForOrder(payload.orderId);
    if (!intent) {
      // A zero-total order legitimately has no intent to reference. Anything
      // else means the events arrived out of order; leaving it unpublished
      // lets the sweep retry once the intent exists.
      if (collectedToman === 0) return;
      throw new Error(`No payment intent found for paid order ${payload.orderId}`);
    }

    const recorded = await this.fundJournal.recordCollection({
      orderId: payload.orderId,
      sellerPartyType: payload.sellerPartyType,
      sellerPartyId: payload.sellerPartyId,
      collectedToman,
      paymentReferenceId: intent.id,
    });

    if (!recorded) {
      this.logger.debug(`Fund journal already recorded collection for order ${payload.orderId} -- idempotent no-op`);
    }
  }
}

/**
 * The same ledger projection, bound to the partial-capture fact — V3.3 #82
 * (`#41c`), ADR-045 §6 and §7.
 *
 * ## Why a second class rather than a widened `eventType`
 *
 * `OutboxRelay` indexes handlers by a single `eventType` string, so one handler
 * subscribes to exactly one event name. Two names therefore need two
 * registrations, and this subclass is the smallest honest way to say that. It
 * changes no dispatch behaviour and adds no version handling — deliberately, per
 * `V33-DEC-024` Ruling 1.
 *
 * The inherited `handle` reads `platformCollectedToman` when present and
 * `totalToman` otherwise, so both events post exactly the money BeauClick
 * collected and neither can post a venue balance.
 */
@Injectable()
export class OrderCollectionCapturedLedgerHandler extends OrderPaidLedgerHandler {
  readonly eventType = 'OrderCollectionCaptured';
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
    /*
     * V3.3 #82 (ADR-045 §5). Compared against the CAPTURED PRINCIPAL, not the
     * service total. Under a deposit the service total is larger, so this guard
     * would fail to fire and the second delivery would hit the CHECK constraint
     * as a thrown error -- leaving the outbox row unpublished and retrying for
     * ever, which is exactly what the guard exists to prevent.
     */
    const alreadyCounted = order.refundedTotalToman >= order.collectedTotalToman;
    if (alreadyCounted) return;

    await this.orders.recordRefund(payload.orderId, payload.amountToman, payload.refundId);
  }
}

/**
 * The regime router (ADR-052 §16): "the regime is fixed per order by where
 * its collection fact lives". An order's `financial.ledger_entries` row, if
 * it has one, was written before this deploy (`LedgerService.recordPayment`
 * no longer exists to write a new one) and stays authoritative for that
 * order FOREVER -- so a refund against it must keep reversing there, at the
 * cumulative rule `LedgerService.recordRefund` now implements. Every other
 * order collected a `financial.fund_journals` `collection` row instead, and
 * its refund draws `pending` through `FundJournalService`.
 *
 * The check is a real read (`LedgerService.hasLegacyPayment`), not a date or
 * a feature flag: a race between a very-late legacy payment record and this
 * deploy is resolved by which table actually has the row, not by when the
 * order was created.
 */
@Injectable()
export class OrderRefundedLedgerHandler implements DomainEventHandler {
  readonly eventType = 'OrderRefunded';

  constructor(
    private readonly ledger: LedgerService,
    private readonly fundJournal: FundJournalService,
  ) {}

  /**
   * Idempotent on both sides of the router: `LedgerService.recordRefund` via
   * `UNIQUE(entry_type, reference_type, reference_id)`, `FundJournalService.recordRefund`
   * via `uq_fund_journals_idempotency_key` on `refund:<refundId>`. A
   * redelivery re-evaluates the SAME routing decision (the order's regime
   * never changes) and lands on the same no-op either way.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { orderId: string; refundId: string; refundAmountToman: number };

    const isLegacy = await this.ledger.hasLegacyPayment(payload.orderId);
    if (isLegacy) {
      await this.ledger.recordRefund({
        orderId: payload.orderId,
        refundId: payload.refundId,
        refundAmountToman: payload.refundAmountToman,
      });
      return;
    }

    await this.fundJournal.recordRefund({
      orderId: payload.orderId,
      refundId: payload.refundId,
      refundAmountToman: payload.refundAmountToman,
    });
  }
}

/**
 * A cancelled booking's money outcome — decided once, then executed.
 *
 * ## What it was, and what it is now (V3.3 #160, `#42c`, ADR-051 §6)
 *
 * This handler used to refund the order's whole remaining collected amount for
 * every cancellation, with no time comparison, no terms and no record of why.
 * That behaviour closed V2's FIN-02 gap by construction — the refund is a
 * consequence of the cancellation event itself, so no cancellation path can be
 * added later that forgets it — and that property is kept.
 *
 * What changed is who decides the amount. `BookingOutcomeOrchestrator` commits
 * ONE `commerce.booking_outcome_decisions` row from the booking's accepted
 * terms (or their absence), the database-clock instant of the cancelling
 * transaction, the Legal cap's current state and the money already committed
 * to refunds; only then is the refund executed, under the same booking-derived
 * key this handler always used. Without every input a retention needs, the
 * decision is today's full refund. A never-collected order is still cancelled
 * with no provider call (`NEVER_COLLECTED_STATUSES`, V3.3 #81).
 *
 * ## Idempotent
 *
 * A redelivery finds the live decision and never evaluates again; the refund
 * call is idempotent on `UNIQUE(order_id, request_key)`.
 *
 * ## No money on a fact with nothing behind it
 *
 * The cause, confirmation and instant are read from the booking itself, never
 * from the payload. A `BookingCancelled` whose booking records no cancellation
 * decides nothing and refunds nothing.
 */
@Injectable()
export class BookingCancelledRefundHandler implements DomainEventHandler {
  readonly eventType = 'BookingCancelled';

  constructor(
    private readonly outcomes: BookingOutcomeOrchestrator,
    private readonly bookings: BookingService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const { bookingId } = envelope.payload as { bookingId: string };

    const decision = await this.outcomes.decideCancellation(bookingId, (manager, cutoffHours) =>
      this.bookings.cancellationFacts(manager, bookingId, cutoffHours),
    );
    if (!decision) return;

    await this.outcomes.executeCancellation(decision);
  }
}

@Injectable()
export class BookingExpiredOrderHandler implements DomainEventHandler {
  readonly eventType = 'BookingExpired';

  constructor(private readonly orders: OrderService) {}

  /**
   * An abandoned hold's order is cancelled so it stops showing as awaiting
   * payment. `cancel()` only touches an order BeauClick never collected for --
   * `pending` or, since V3.3 #81, `online_collection_not_required` -- so an
   * order that was in fact paid just as the hold lapsed is left alone. That
   * case is the paid-but-unconfirmable path's responsibility, not this one's.
   *
   * The `online_collection_not_required` case is reachable but rare: the
   * booking is confirmed inside the same transaction that sets that status, so
   * a `BookingExpired` for it means the hold lapsed before confirmation and the
   * order never left `pending`. The widened predicate costs nothing and stops
   * the handler being the one place the new status is silently unhandled.
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
