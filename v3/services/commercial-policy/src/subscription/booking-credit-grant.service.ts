import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { INITIAL_GRANT_PERIOD_INDEX } from '@beauclick/commercial-policy-contract';

import { BookingCreditGrantEntity, SellerSubscriptionEntity } from './seller-subscription.entities';
import { AUDIT_TARGET_SUBSCRIPTION, SUBSCRIPTION_AUDIT_REASONS, SYSTEM_ACTOR_LABEL } from './seller-subscription.audit';

/**
 * Issues the entitlement grants a subscription confers.
 *
 * ## Everything here reads the SNAPSHOT, never the catalogue
 *
 * `issueForActivation` takes a subscription row and copies its
 * `snapshotIncludedBookingCredits`. It does not accept a quantity, and it does
 * not look up the plan version. That is the whole design: a grant that read the
 * catalogue would depend on WHEN it ran, so replaying an activation after an
 * administrator published new terms would confer different credits from the
 * ones the seller actually holds.
 *
 * ## A zero-quantity grant is written
 *
 * The seeded `D-7` confers zero credits, and it is tempting to skip the row.
 * `V33-DEC-018` requires it, and the reason is that skipping makes the absence
 * ambiguous: "this subscription conferred nothing" and "this subscription has
 * not been processed yet" would look identical, and #58 would have to guess.
 * That guess is the implicit fallback this family exists to delete, wearing an
 * empty table.
 *
 * ## Idempotency is the database's, not this class's
 *
 * `uq_booking_credit_grants_once` on `(subscription_id, source, period_index)`
 * is the guarantee. This method does a read-first for a readable outcome, and
 * that read is an optimisation, not the protection: two concurrent activations
 * both find nothing, both insert, and the index refuses one. That refusal is
 * caught and the winner's row returned, so a replay is indistinguishable from
 * the original call.
 */
@Injectable()
export class BookingCreditGrantService {
  constructor(private readonly audit: AdminAuditService) {}

  /**
   * The one-time grant for a newly activated subscription.
   *
   * Idempotent by unique index. Returns the grant that exists afterwards,
   * whether this call wrote it or lost the race.
   *
   * @param manager the ACTIVATING transaction's manager. A grant written on a
   * different connection could not roll back with the subscription it belongs
   * to (ADR-042 §9), so there is no overload that opens its own.
   */
  async issueForActivation(
    manager: EntityManager,
    subscription: SellerSubscriptionEntity,
  ): Promise<BookingCreditGrantEntity> {
    const repository = manager.getRepository(BookingCreditGrantEntity);
    const where = {
      subscriptionId: subscription.id,
      source: 'plan_included' as const,
      periodIndex: INITIAL_GRANT_PERIOD_INDEX,
    };

    const existing = await repository.findOne({ where });
    if (existing) return existing;

    const grant = repository.create({
      id: uuidv7(),
      subscriptionId: subscription.id,
      planVersionId: subscription.planVersionId,
      // Copied from the subscription rather than re-resolved, so #58's return
      // path reaches the party that actually held the entitlement
      // (`V33-DEC-010`).
      subscriberPartyType: subscription.subscriberPartyType,
      subscriberPartyId: subscription.subscriberPartyId,
      source: 'plan_included',
      quantity: subscription.snapshotIncludedBookingCredits,
      periodIndex: INITIAL_GRANT_PERIOD_INDEX,
      // `expiresAt` is deliberately not set, by anything, ever. The column is
      // pinned NULL by `ck_booking_credit_grants_no_expiry`; activating expiry
      // is a visible migration after Legal approves (`V33-DEC-010`).
    });

    await repository.insert(grant);

    await this.audit.recordSystem(manager, {
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: 'commercial.credits_granted',
      targetType: AUDIT_TARGET_SUBSCRIPTION,
      targetId: subscription.id,
      after: {
        source: 'plan_included',
        quantity: grant.quantity,
        periodIndex: INITIAL_GRANT_PERIOD_INDEX,
      },
      reason: SUBSCRIPTION_AUDIT_REASONS.creditsGranted,
    });

    return grant;
  }
}
