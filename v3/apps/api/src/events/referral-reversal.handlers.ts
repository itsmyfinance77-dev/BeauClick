import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ReferralReversed,
  parseEnvelope,
} from '@beauclick/event-contracts';
import { ReferralReversalService } from '@beauclick/referral';
import { NotificationService } from '@beauclick/notification';

/**
 * Referral reversal, and the notification it produces — V3.2-C Story #28
 * (ADR-038 §§1, 7, 10).
 *
 *   OrderRefunded    -> reverse a qualified referral if this refund was FULL,
 *                       both sides, both clawbacks, one outbox event, ONE
 *                       transaction
 *   ReferralReversed -> notify each party about their own side, in-app,
 *                       opt-outable
 */

/**
 * A full refund of a qualifying booking's order reverses its referral.
 *
 * ## Why `OrderRefunded` and not `RefundCompleted`
 *
 * `V32-DEC-018` splits the authorities: **booking qualifies, payment reverses**
 * — and `OrderRefunded` is the point where a gateway-level refund has been
 * reconciled against the order it concerns. `RefundCompleted` is the earlier,
 * rawer fact, and consuming it would mean this handler deciding for itself
 * whether the money belonged to the order at all. It also would not work:
 * `RefundCompleted` with `kind: 'duplicate_charge'` is money that was never
 * part of the order's accounting, and `V32-DEC-017` says such a correction
 * **never** reverses.
 *
 * That refusal needs no branch here, and the absence is stronger than a check
 * would be. `RefundCompletedCommerceHandler` returns before calling
 * `recordRefund` for a duplicate charge, and that handler is `recordRefund`'s
 * **only production caller** — so a duplicate charge never moves the order's
 * refunded total, never moves its status, and never produces an `OrderRefunded`
 * event. There is nothing to guard against because the event does not arrive.
 *
 * **Booking cancellation is not a trigger and could not be one.**
 * `LEGAL_TRANSITIONS` maps `completed` to an empty set, so a booking that
 * qualified a referral can never be cancelled. A cancellation handler would be
 * an unreachable branch no test could honestly cover.
 *
 * ## Not a raw payload read
 *
 * `OrderRefunded` is parsed off the envelope rather than through the contract
 * registry, and that is the one place this file differs from its qualification
 * counterpart. The reason is in the event catalogue: `OrderRefunded` is emitted
 * by `emitEvent` with a hand-built payload rather than through
 * `emitContractEvent`, so a registry parse would be asserting a contract the
 * producer does not go through. Only `orderId` is read, it is used solely as a
 * lookup key against the authoritative table, and a malformed one resolves to
 * no order and reverses nothing.
 *
 * ## The handler owns the transaction
 *
 * The relay dispatches with **no ambient transaction**, so this handler opens
 * one and every effect commits or rolls back together (ADR-038 §7): the
 * compare-and-swap, both reversal rows, both negative ledger rows, and the
 * outbox event. One side clawed back with the other still standing is precisely
 * the state an audit could never explain.
 *
 * ## Every `OrderRefunded` reaches here, and almost none reverses
 *
 * Most refunds are partial, belong to `direct` orders, or belong to bookings
 * whose customer was never referred. Those paths cost one indexed order read
 * and — for the last of them — one `UPDATE` served by
 * `ix_referrals_qualified_booking` that affects zero rows. Nothing is written.
 */
@Injectable()
export class OrderRefundedReferralHandler implements DomainEventHandler {
  readonly eventType = 'OrderRefunded';
  private readonly logger = new Logger('OrderRefundedReferralHandler');

  constructor(
    private readonly dataSource: DataSource,
    private readonly reversal: ReferralReversalService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { orderId?: unknown };
    if (typeof payload.orderId !== 'string') return;
    const orderId = payload.orderId;

    const result = await this.dataSource.transaction((manager) =>
      this.reversal.reverseForRefundedOrder(manager, orderId),
    );

    // `debug`, not `log`: the overwhelming majority of refunds concern orders no
    // referral was ever attached to, and an info line for each would bury the
    // ones that matter. The reversal service logs the ones that do.
    if (!result.reversed) {
      this.logger.debug(`No qualified referral reversed by the refund of order ${orderId}`);
    }
  }
}

/**
 * The in-app notification for a reversed referral — `V32-DEC-033`, ADR-038 §10.
 *
 * ## Each party told about their own side, and nothing about the other
 *
 * The same asymmetry `ReferralQualifiedNotificationHandler` keeps, and the same
 * reason: `V32-DEC-019` binds a referrer's export to carry **no referee
 * identity** and a referee's to carry **never the referrer's bearer code**, and
 * a notification is a message about the same relationship. Neither template
 * names, implies, or is addressed to the counterparty.
 *
 * ## No points figure, and here that is more than caution
 *
 * Both configured values are **0** today, so with `nothing_to_reverse` on both
 * sides a message saying points were taken back would be **false**. But even
 * with a real figure it would be wrong to send one: a customer's balance is
 * shown by the loyalty surface, which reads the ledger, and a notification
 * quoting a number is a second source of truth that can disagree with it.
 * `requiredVars` is empty on both templates, so there is no variable a figure,
 * a name, a code or an order id could travel through even if a later author
 * wanted one.
 *
 * ## Sent regardless of the per-side outcome
 *
 * Both parties are notified even when a side had nothing to reverse. The fact
 * being reported is *"the referral you were part of was reversed"*, which is
 * true for both of them and is the thing a person would want to know; branching
 * on the ledger outcome would tell a customer about their referral only when
 * money happened to have moved, which is an odd rule to explain and a worse one
 * to discover.
 *
 * ## Why a consumer rather than part of the transaction
 *
 * The notification is produced **downstream of the committed reversal**, so a
 * delivery failure retries through the existing outbox model against a ledger
 * that is already correct. Notifying inside the transaction would let a
 * notification outage roll back a clawback the platform had correctly applied —
 * which is the free-points loop `V32-DEC-017` closes, reopened by an unrelated
 * failure.
 *
 * `NotificationService.notify` is itself idempotent on
 * `(templateKey, entityType, entityId, userId, channel)`, so a redelivered
 * `ReferralReversed` re-notifies nobody. That is why this handler needs no
 * dedupe of its own.
 */
@Injectable()
export class ReferralReversedNotificationHandler implements DomainEventHandler {
  readonly eventType = ReferralReversed.name;
  readonly eventVersion = ReferralReversed.version;

  constructor(
    private readonly notifications: NotificationService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ReferralReversed, envelope);

    // Two notifications, one per party, both under the opt-outable `referral`
    // category. The category is deliberately absent from `MANDATORY_CATEGORIES`
    // and stays that way (`V32-DEC-033`), so a customer who has switched
    // referral notifications off receives neither -- which `NotificationService`
    // handles by suppressing, not by failing.
    //
    // `entityId` is the REFERRAL id for both, and the recipient distinguishes
    // the two idempotency keys -- so the referrer's and the referee's
    // notifications never collide with each other, and neither collides with
    // the qualification notification, which uses different template keys.
    await this.notifications.notify({
      userId: payload.referrerUserId,
      templateKey: 'referral_reversed_referrer',
      entityType: 'referral',
      entityId: payload.referralId,
      // Empty, and the template requires nothing. There is no variable here a
      // points figure, a name, a code, or an order id could enter through.
      vars: {},
    });

    await this.notifications.notify({
      userId: payload.refereeUserId,
      templateKey: 'referral_reversed_referee',
      entityType: 'referral',
      entityId: payload.referralId,
      vars: {},
    });
  }
}
