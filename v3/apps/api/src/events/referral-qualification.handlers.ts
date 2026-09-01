import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import {
  BookingCompleted,
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ReferralQualified,
  parseEnvelope,
} from '@beauclick/event-contracts';
import { ReferralQualificationService } from '@beauclick/referral';
import { NotificationService } from '@beauclick/notification';

/**
 * Referral qualification, and the notification it produces — V3.2-C Story #12
 * (ADR-037 §§1, 5, 11).
 *
 *   BookingCompleted  -> qualify a pending referral, both grants, both awards,
 *                        one outbox event, ONE transaction
 *   ReferralQualified -> notify both parties, in-app, opt-outable
 */

/**
 * The referee's first completed booking qualifies their referral.
 *
 * ## This is the ONLY event that qualifies, and the refusals are structural
 *
 * `V32-DEC-018` decided *(a) the referee's first `BookingCompleted`, and
 * nothing else*. Registration never qualifies, `BookingConfirmed` never
 * qualifies — the service is still in the future — and **`OrderPaid` never
 * qualifies**, which the decision calls the sharper refusal: money moves before
 * delivery and can be refunded within minutes, so qualifying on payment would
 * maximise the window in which a reward exists for a service that never
 * happened.
 *
 * Those refusals are enforced by there being **no other handler** and no other
 * caller of `ReferralQualificationService.qualify`. Nothing polls the booking
 * table, nothing reads `OrderPaid`, and no route can trigger a qualification.
 *
 * ## The handler owns the transaction, and that is why it exists here
 *
 * The relay dispatches handlers with **no ambient transaction**, so this
 * handler opens one and every effect commits or rolls back together: the
 * compare-and-swap, the booking snapshot, the cap increment, both grants, both
 * ledger awards, and the outbox event (ADR-037 §5).
 *
 * `BookingCompletedLoyaltyHandler` — which awards the customer's own booking
 * points — deliberately does **not** share this transaction and must not. It is
 * a separate fact with a separate idempotency key, and coupling the two would
 * mean a referral bug could roll back a booking reward the customer had
 * genuinely earned.
 *
 * ## Every `BookingCompleted` reaches here, and almost none qualifies
 *
 * Most customers were never referred. That path costs exactly one `UPDATE`
 * affecting zero rows, served by `ix_referrals_pending_referee` — no `SELECT`
 * first, no branch, and nothing written. The transaction wrapping it is cheap
 * for the same reason: it commits an empty write set.
 */
@Injectable()
export class BookingCompletedReferralHandler implements DomainEventHandler {
  readonly eventType = BookingCompleted.name;
  readonly eventVersion = BookingCompleted.version;
  private readonly logger = new Logger('BookingCompletedReferralHandler');

  constructor(
    private readonly dataSource: DataSource,
    private readonly qualification: ReferralQualificationService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    // Parsed through the registry rather than read off `envelope.payload`, so
    // a producer at v2 against this v1 consumer is a loud, specific failure
    // naming the field rather than an `undefined` flowing into a column.
    const payload = parseEnvelope(this.contracts, BookingCompleted, envelope);

    const result = await this.dataSource.transaction(async (manager) =>
      this.qualification.qualify(manager, {
        // `customerId` IS the referee. `BookingCompleted` v1 already carries
        // both identifiers this story needs, which is why no lookup port over
        // `booking` was declared (ADR-037 §4).
        refereeUserId: payload.customerId,
        bookingId: payload.bookingId,
      }),
    );

    // `debug`, not `log`: the overwhelming majority of completed bookings
    // belong to customers who were never referred, and an info line for each
    // would bury the ones that matter.
    if (!result.qualified) {
      this.logger.debug(`No pending referral qualified by booking ${payload.bookingId}`);
    }
  }
}

/**
 * The in-app notification for a qualified referral — `V32-DEC-033`, ADR-037 §11.
 *
 * ## Both parties, each told about their own referral
 *
 * `V32-DEC-033` describes the moment as telling *"somebody what happened to
 * their own referral"*, and both sides have one. Neither message names or
 * implies the other party, which is the same asymmetry `V32-DEC-019` binds for
 * the two export shapes.
 *
 * ## No points figure, and that is correctness rather than caution
 *
 * Both configured values are **0** today, so a message saying anything was
 * earned would be **false**. The templates state the qualification fact, which
 * is true whatever the configured economics are — and `requiredVars` is empty,
 * so there is no variable a figure, a name, or a code could travel through even
 * if a later author wanted one.
 *
 * ## Why a consumer rather than part of the transaction
 *
 * The notification is produced **downstream of the committed qualification**,
 * so a delivery failure retries through the existing outbox/consumer model
 * against a ledger that is already correct. Notifying inside the transaction
 * would let a notification outage roll back a reward the customer had earned.
 *
 * `NotificationService.notify` is itself idempotent on
 * `(templateKey, entityType, entityId, userId, channel)`, so a redelivered
 * `ReferralQualified` re-notifies nobody. That is the reason this handler needs
 * no dedupe of its own.
 */
@Injectable()
export class ReferralQualifiedNotificationHandler implements DomainEventHandler {
  readonly eventType = ReferralQualified.name;
  readonly eventVersion = ReferralQualified.version;

  constructor(
    private readonly notifications: NotificationService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ReferralQualified, envelope);

    // Two notifications, one per party, each under the opt-outable `referral`
    // category. The category is deliberately absent from
    // `MANDATORY_CATEGORIES` and stays that way (`V32-DEC-033`), so a customer
    // who has switched referral notifications off receives neither -- which
    // `NotificationService` handles by suppressing, not by failing.
    //
    // `entityId` is the REFERRAL id for both, and the recipient distinguishes
    // the two idempotency keys -- so the referrer's and the referee's
    // notifications never collide with each other.
    await this.notifications.notify({
      userId: payload.referrerUserId,
      templateKey: 'referral_qualified_referrer',
      entityType: 'referral',
      entityId: payload.referralId,
      // Empty, and the template requires nothing. There is no variable here a
      // code, a name, or a points figure could enter through.
      vars: {},
    });

    await this.notifications.notify({
      userId: payload.refereeUserId,
      templateKey: 'referral_qualified_referee',
      entityType: 'referral',
      entityId: payload.referralId,
      vars: {},
    });
  }
}
