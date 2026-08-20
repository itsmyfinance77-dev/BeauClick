import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BookingService, CreateBookingInput } from '@beauclick/booking';
import { OrderService, OrderWithDetail } from '@beauclick/commerce';
import { PaymentService, VerificationOutcome } from '@beauclick/payment';
import { OutboxRelay } from '@beauclick/events';

export interface CheckoutResult {
  bookingId: string;
  order: OrderWithDetail;
  paymentIntentId: string;
  redirectUrl: string | null;
}

export interface CallbackResult {
  outcome: VerificationOutcome;
  refundIssued: boolean;
  /** True when this callback was a genuine SECOND charge that had to be given back. */
  duplicateChargeRefunded: boolean;
}

/**
 * The composition root's transaction boundaries.
 *
 * This class exists because the two hardest consistency questions in Phase 2
 * span module boundaries, and answering them honestly means deciding WHERE
 * atomicity is required rather than reaching for events everywhere because
 * events exist. The decisions, and the reasons:
 *
 * **1. Booking + Order: ONE transaction (synchronous, ACID).**
 * A booking that exists without its order is a customer holding a slot with
 * nothing to pay, and an order without its booking is a charge for nothing.
 * Both tables live in the same PostgreSQL cluster, so a real transaction is
 * available -- and choosing eventual consistency here would mean every
 * reader, forever, defending against a window that does not need to exist.
 *
 * **2. Payment + Order-paid + Booking-confirmed: ONE transaction.**
 * This is where V2 bled. Its payment path confirmed the booking in a
 * separate step from recording the payment, which produced the
 * "paid but unconfirmable" case it then had to detect and compensate for.
 * Putting all three in one transaction removes the window entirely: either
 * the money is recorded AND the slot is confirmed, or neither happened.
 *
 * **3. Financial ledger: eventual, via the outbox.**
 * Deliberately NOT in the transaction above -- and not because it matters
 * less, but because it is on a different CONNECTION (the append-only
 * financial role, ADR-017) and therefore cannot join that transaction at
 * all. The outbox makes this safe rather than merely convenient: the event
 * commits with the payment, and the ledger's `UNIQUE(entry_type,
 * reference_type, reference_id)` makes replay a no-op. At-least-once
 * delivery plus an idempotent consumer is exactly-once in effect.
 *
 * **4. Refunds: after the commit, never inside it.**
 * A refund is a network call to a bank. Holding a transaction open across
 * it would pin a connection and row locks for the duration of an external
 * system's latency.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger('CheckoutService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly bookings: BookingService,
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
    private readonly relay: OutboxRelay,
  ) {}

  /**
   * Book a slot and produce the order for it, atomically.
   *
   * The whole operation is idempotent: `create()` replays a booking on a
   * repeated idempotency key, and `createForBooking()` is idempotent on
   * `(source_type, source_id)` by database constraint. A double-clicked
   * "book" button therefore converges on ONE booking and ONE order, and a
   * network retry returns the same pair rather than a second slot claim.
   */
  async checkout(input: CreateBookingInput & { callbackUrl: string }): Promise<CheckoutResult> {
    const { bookingId, order } = await this.dataSource.transaction(async (manager) => {
      const booking = await this.bookings.create(
        {
          customerId: input.customerId,
          professionalId: input.professionalId,
          slotId: input.slotId,
          serviceId: input.serviceId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
        manager,
      );

      const created = await this.orders.createForBooking(
        {
          bookingId: booking.id,
          customerId: booking.customerId,
          professionalId: booking.professionalId,
          serviceId: booking.serviceId,
        },
        manager,
      );

      return { bookingId: booking.id, order: created };
    });

    // Outside the transaction: creating an intent touches the payment
    // provider registry, and a gateway misconfiguration must not roll back a
    // perfectly valid booking. If this throws, the customer still has their
    // booking and can retry payment until the hold expires.
    const intent = await this.payments.createIntentForOrder({
      orderId: order.order.id,
      customerId: order.order.customerId,
      amountToman: order.order.totalToman,
    });

    let redirectUrl: string | null = null;
    if (order.order.totalToman > 0) {
      const initiated = await this.payments.initiate(intent.id, input.callbackUrl, `رزرو نوبت — سفارش ${order.order.id}`);
      redirectUrl = initiated.redirectUrl;
    }

    await this.drainQuietly();
    return { bookingId, order, paymentIntentId: intent.id, redirectUrl };
  }

  /**
   * Handle a gateway callback.
   *
   * Step 1 asks the GATEWAY what happened (a server-to-server call, outside
   * any transaction -- the browser's callback parameters are never treated
   * as proof). Step 2 records the answer, marks the order paid, and confirms
   * the booking, all atomically.
   *
   * The `paid but unconfirmable` case: if the hold lapsed and the slot went
   * to somebody else while the customer was at the gateway, `confirm()`
   * returns false. The money genuinely moved, so the payment record MUST
   * stand -- rolling it back would lose a real charge. Instead the
   * transaction commits and an automatic refund is issued afterwards,
   * keyed deterministically so a retry cannot refund twice. This is V2's
   * hardest-won payment rule, preserved exactly.
   */
  async handleCallback(
    providerKey: string,
    providerReference: string,
    callbackParams: Record<string, string>,
  ): Promise<CallbackResult> {
    const prepared = await this.payments.prepareVerification(providerKey, providerReference, callbackParams);

    const { outcome, bookingUnavailable, duplicateCharge } = await this.dataSource.transaction(async (manager) => {
      const verification = await this.payments.applyVerification(prepared, manager);
      if (verification.status !== 'succeeded') {
        return { outcome: verification, bookingUnavailable: false, duplicateCharge: false };
      }

      const marked = await this.orders.markPaid(verification.orderId, manager);
      if (!marked) {
        // THIS attempt just won its own compare-and-swap, meaning the gateway
        // confirmed a payment that had not been recorded before -- yet the
        // order was already paid. That is not a replay of the same
        // transaction; it is a genuine SECOND charge, and real money moved.
        //
        // Found in Phase 2 live QA: a retried checkout used to open a second
        // gateway attempt, so two chargeable references existed for one
        // intent. `initiate()` now reuses a live attempt and a partial unique
        // index forbids a second one -- but a customer who kept an old
        // redirect URL open could still get here, so the money is given back
        // rather than silently absorbed.
        return {
          outcome: { ...verification, status: 'replayed' as const },
          bookingUnavailable: false,
          duplicateCharge: true,
        };
      }

      const order = await this.orders.findById(verification.orderId, manager);
      if (!order || order.sourceType !== 'booking') {
        return { outcome: verification, bookingUnavailable: false, duplicateCharge: false };
      }

      const confirmed = await this.bookings.confirm(order.sourceId, { type: 'system', id: null }, manager);
      return { outcome: verification, bookingUnavailable: !confirmed, duplicateCharge: false };
    });

    let refundIssued = false;
    let duplicateChargeRefunded = false;

    if (duplicateCharge) {
      this.logger.error(
        `DUPLICATE CHARGE detected on order ${outcome.orderId} (attempt ${outcome.attemptId}). Refunding the second charge.`,
      );
      await this.payments.refund({
        orderId: outcome.orderId,
        amountToman: outcome.amountToman,
        reason: 'پرداخت تکراری برای همین سفارش — بازگشت خودکار وجه.',
        // Keyed by the ATTEMPT, not the order: the order legitimately has one
        // real payment, and only this extra attempt is being corrected.
        requestKey: `duplicate-charge:${outcome.attemptId}`,
        actorType: 'system',
        actorId: null,
        kind: 'duplicate_charge',
        paymentAttemptId: outcome.attemptId,
      });
      duplicateChargeRefunded = true;
    }

    if (bookingUnavailable) {
      this.logger.error(
        `Payment ${outcome.intentId} succeeded but its booking could not be confirmed (order ${outcome.orderId}). Auto-refunding.`,
      );
      await this.payments.refund({
        orderId: outcome.orderId,
        amountToman: outcome.amountToman,
        reason: 'زمان رزرو پیش از تکمیل پرداخت منقضی شد — بازگشت خودکار وجه.',
        // Deterministic per order, so a retried callback reuses the same
        // refund rather than issuing a second one.
        requestKey: `booking-unconfirmable:${outcome.orderId}`,
        actorType: 'system',
        actorId: null,
      });
      refundIssued = true;
    }

    await this.drainQuietly();
    return { outcome, refundIssued, duplicateChargeRefunded };
  }

  /**
   * Drains the outbox right after a commit, so the common path settles
   * immediately instead of waiting for the periodic sweep.
   *
   * Failures are swallowed on purpose: the sweep is the durability
   * guarantee, and an unpublished row is retried automatically. Letting a
   * relay hiccup fail a request whose business transaction already
   * committed would report failure for work that actually succeeded.
   */
  private async drainQuietly(): Promise<void> {
    try {
      await this.relay.drain();
    } catch (err) {
      this.logger.warn(`Post-commit outbox drain failed; the periodic sweep will retry: ${String(err)}`);
    }
  }
}
