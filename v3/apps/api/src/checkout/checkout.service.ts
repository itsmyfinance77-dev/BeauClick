import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BookingService, CreateBookingInput } from '@beauclick/booking';
import { OrderService, OrderWithDetail } from '@beauclick/commerce';
import {
  PaymentIntentNotFoundException,
  PaymentRetryNotAvailableException,
  PaymentService,
  VerificationOutcome,
} from '@beauclick/payment';
import { OutboxRelay } from '@beauclick/events';
import { METRICS, MetricsRegistry } from '@beauclick/observability';

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
    /**
     * `@Optional()` for the same reason the exception filter's reporter is:
     * a composition that omits `ObservabilityModule` must still be able to
     * take a payment. A metric is never worth failing a checkout for.
     */
    @Optional() private readonly metrics?: MetricsRegistry,
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
  async checkout(input: CreateBookingInput & { callbackBaseUrl: string }): Promise<CheckoutResult> {
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
      const initiated = await this.payments.initiate(intent.id, input.callbackBaseUrl, `رزرو نوبت — سفارش ${order.order.id}`);
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

    /**
     * The one metric worth alerting on in this whole domain.
     *
     * `unresolved` means a payment whose result NOBODY knows -- the gateway
     * was not reached, or did not answer definitively, and the platform
     * deliberately wrote nothing. A handful of those is a bad network minute;
     * a sustained rate is money moving with no record of it, and it is
     * invisible in every other signal: the request returned 303, the customer
     * got a page, no error was thrown, and no event was emitted. Counting it
     * here is what makes it visible at all.
     *
     * Labelled by OUTCOME only. Never by order, customer, or provider
     * reference -- see `MetricsRegistry` on why an unbounded label kills the
     * monitoring system it feeds.
     */
    this.metrics?.increment(METRICS.paymentVerifications, {
      outcome: duplicateChargeRefunded ? 'duplicate_refunded' : refundIssued ? 'refunded' : outcome.status,
    });

    await this.drainQuietly();
    return { outcome, refundIssued, duplicateChargeRefunded };
  }

  /**
   * Send a customer back to the gateway for an order whose payment failed
   * (V3.1 Phase F design, §2 of `16_CHECKOUT_RESULT.md`).
   *
   * ## Why this is order-scoped and not intent-scoped
   *
   * The result page holds an `orderId` and nothing else -- the redirect
   * contract deliberately carries no `intentId`, and it should not start: an
   * intent id in a URL is a payment-domain identifier in browser history, a
   * referrer header, and every analytics script the page loads, for no benefit
   * the customer's own order id does not already provide.
   *
   * So the command takes the order, and the SERVER resolves which intent that
   * means. The `orderId` is untrusted input, and it does not need to be
   * trusted: `OrderOwnerResolver` on the route resolves the owner from the
   * order row and compares it to the session, returning the same
   * `NOT_FOUND_OR_NOT_YOURS` whether the order does not exist or belongs to
   * somebody else.
   *
   * ## What is checked, and why each one
   *
   * Every input to every decision below is read from the database. Nothing is
   * taken from the request except the order id, whose only power is to select
   * a row the caller has already been proven to own.
   *
   *  1. **The order still owes money.** `paid`, `refunded`,
   *     `partially_refunded`, and `cancelled` are all refusals. Without this a
   *     customer could be sent to a bank for an order that has already
   *     settled.
   *  2. **The intent belongs to the same customer.** Redundant with the route
   *     guard by design: the guard resolves from `commerce.orders` and this
   *     reads `payment.payment_intents`, so the two agree only if the data is
   *     consistent, and a disagreement fails closed.
   *  3. **The intent has not succeeded, been cancelled, or expired**, and its
   *     window has not lapsed. `PaymentService.initiate` re-checks all of this
   *     and would refuse anyway; checking here turns a generic
   *     `NOT_PAYABLE` into a specific, closed-vocabulary refusal the page can
   *     render.
   *  4. **No gateway transaction is open.** This is the one that makes
   *     `unresolved` genuinely unretryable, and it is worth stating plainly:
   *     an `unknown` verification writes NOTHING -- the attempt stays
   *     `initiated` and the intent stays `pending` -- so the intent's stored
   *     failure code is still whatever the PREVIOUS attempt recorded. Deciding
   *     on the failure code alone would therefore offer a retry on a payment
   *     that may already have taken the customer's money. An open attempt is
   *     the honest signal, and all three situations it covers (at the bank,
   *     abandoned, unresolved) must be refused identically because from here
   *     they are indistinguishable.
   *  5. **The recorded failure is one a retry can fix.** Derived from
   *     `intent.failureCode` through the closed public vocabulary. The
   *     caller's `reason` query parameter is never read.
   *
   * ## Concurrency
   *
   * Deliberately no lock and no transaction around the checks. Two concurrent
   * retries both pass, both call `initiate`, and `initiate`'s own invariants
   * resolve it: it reuses a live attempt if one exists, and
   * `uq_payment_attempts_live_per_intent` -- a partial unique index over
   * attempts still `initiated` -- makes a second one impossible at the
   * database level, so the loser catches the unique violation and returns the
   * winner's redirect URL. Exactly one chargeable gateway transaction, and
   * both callers get the same one.
   *
   * Adding a transaction here would not improve that and would make it worse:
   * it would hold a connection across `provider.initiate`, an HTTP round trip
   * to a bank, which is the thing `initiate` is carefully written not to do.
   *
   * ## What it returns
   *
   * The redirect URL and nothing else. No provider reference, no attempt id,
   * no intent id, no stored failure code.
   */
  async retryPayment(input: {
    orderId: string;
    customerId: string;
    callbackBaseUrl: string;
  }): Promise<{ redirectUrl: string }> {
    const order = await this.orders.findById(input.orderId);
    // The route's ownership guard already answered both of these. Repeated
    // because this method is the one that issues a payment, and a future
    // caller that forgets the decorator must not become a hole.
    if (!order || order.customerId !== input.customerId) throw new PaymentIntentNotFoundException();

    if (order.status !== 'pending') throw new PaymentRetryNotAvailableException('order_not_payable');

    const intent = await this.payments.findLatestIntentForOrder(input.orderId);
    if (!intent) throw new PaymentRetryNotAvailableException('no_payment_started');
    if (intent.customerId !== input.customerId) throw new PaymentIntentNotFoundException();

    if (intent.status === 'succeeded') throw new PaymentRetryNotAvailableException('already_paid');
    if (intent.status === 'expired' || intent.expiresAt.getTime() <= Date.now()) {
      throw new PaymentRetryNotAvailableException('expired');
    }
    if (intent.status === 'cancelled') throw new PaymentRetryNotAvailableException('order_not_payable');

    const open = await this.payments.findOpenAttemptForIntent(intent.id);
    if (open) throw new PaymentRetryNotAvailableException('verification_pending');

    if (!this.payments.isIntentRetryable(intent)) throw new PaymentRetryNotAvailableException('not_retryable');

    const initiated = await this.payments.initiate(
      intent.id,
      input.callbackBaseUrl,
      `تلاش دوباره برای پرداخت سفارش ${intent.orderId}`,
    );

    await this.drainQuietly();
    return { redirectUrl: initiated.redirectUrl };
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
