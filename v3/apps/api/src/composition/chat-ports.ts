import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';

import { ChatEligibilityPort, ChatEligibleRelationship, ChatSellerAccessPort } from '@beauclick/chat';
import type { ChatCounterpartyType } from '@beauclick/chat-contract';
import { BusinessEntity, BusinessStaffEntity } from '@beauclick/business';
import { ProfessionalEntity } from '@beauclick/provider';

/**
 * Chat's two ports, implemented here because this is the only place ADR-011
 * permits a cross-domain read.
 *
 * **Read this file as the enforcement of `V32-DEC-010` and `V32-DEC-011`, and
 * specifically of the two corrections the owner made to engineering's proposal.**
 * Both live in SQL below rather than in prose, which is the point of putting
 * them here.
 */

/**
 * Booking eligibility.
 *
 * ## The two corrections, as SQL
 *
 * **1. `cancelled` requires proven prior confirmation.** The `EXISTS` against
 * `booking.booking_history` is the whole of it. A booking cancelled from
 * `confirmed` is a real appointment that was called off; a booking cancelled from
 * `pending` is a hold a stranger created and abandoned. The two are
 * indistinguishable in `booking.bookings` — the row says `cancelled` either way —
 * and completely distinguishable in the append-only history, which cannot be
 * rewritten by a later status change.
 *
 * Engineering's decision packet accepted any `cancelled` booking. That would have
 * re-opened V2's unauthenticated-messaging surface through the cancellation door:
 * `pending` is the one status any authenticated user can create against any
 * professional, so `pending` → `cancelled` would have been an eligibility grant
 * anybody could mint at will.
 *
 * **2. No fallback to current affiliation.** The counterparty comes from the
 * INNER JOIN to `commerce.orders`, which is a snapshot of the seller party at
 * checkout. A booking whose order is missing, or whose order carries no seller
 * snapshot, simply does not appear in these results — it fails closed. There is
 * no `LEFT JOIN`, no `COALESCE`, and no call to `SellerPartyLookup` anywhere in
 * this class.
 *
 * That is safe because `CheckoutService` creates the booking and the order in one
 * transaction, so "no order" describes corrupt or hand-written data rather than a
 * legitimate booking. And it is necessary because a fallback would fire exactly
 * when the data is least trustworthy, and would let a professional changing salon
 * move a customer's existing conversation to a business they never dealt with.
 *
 * ## Why raw SQL rather than the repository API
 *
 * The query spans three schemas (`booking`, `commerce`, and `booking_history`)
 * and turns on a correlated `EXISTS`. Expressing that through three repositories
 * and joining in memory would read worse and would make the eligibility rule
 * something assembled across several statements rather than one thing a reviewer
 * can check. Cross-schema reads are exactly what the composition root is for.
 */
@Injectable()
export class BookingBackedChatEligibility implements ChatEligibilityPort {

  /**
   * The one query, shared by both methods.
   *
   * `slot_end` and not `completed_at`: `completed_at` is null for `cancelled` and
   * `no_show`, both of which qualify, so measuring the send window from it would
   * leave those two undefined. `slot_end` is populated on every booking at
   * creation.
   */
  private readonly sql = `
    SELECT o.seller_party_type AS counterparty_type,
           o.seller_party_id   AS counterparty_id,
           MAX(b.slot_end)     AS last_slot_end
      FROM booking.bookings b
      -- INNER JOIN, deliberately. A booking with no order snapshot fails closed.
      JOIN commerce.orders o
        ON o.source_type = 'booking' AND o.source_id = b.id
     WHERE b.customer_id = $1
       AND (
             b.status IN ('confirmed', 'completed', 'no_show')
             OR (
                  -- The correction. A cancelled booking qualifies only if the
                  -- append-only history proves it once reached 'confirmed'.
                  b.status = 'cancelled'
                  AND EXISTS (
                    SELECT 1 FROM booking.booking_history h
                     WHERE h.booking_id = b.id
                       AND (h.event = 'confirmed' OR h.to_status = 'confirmed')
                  )
                )
           )
  `;

  async eligibleCounterpartiesFor(
    manager: EntityManager,
    customerUserId: string,
  ): Promise<readonly ChatEligibleRelationship[]> {
    const rows: Array<{ counterparty_type: ChatCounterpartyType; counterparty_id: string; last_slot_end: Date }> =
      await manager.query(
        `${this.sql} GROUP BY o.seller_party_type, o.seller_party_id`,
        [customerUserId],
      );

    return rows.map((row) => ({
      counterpartyType: row.counterparty_type,
      counterpartyId: row.counterparty_id,
      lastQualifyingSlotEnd: new Date(row.last_slot_end),
    }));
  }

  async findRelationship(
    manager: EntityManager,
    customerUserId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<ChatEligibleRelationship | null> {
    const rows: Array<{ counterparty_type: ChatCounterpartyType; counterparty_id: string; last_slot_end: Date }> =
      await manager.query(
        `${this.sql}
           AND o.seller_party_type = $2 AND o.seller_party_id = $3
         GROUP BY o.seller_party_type, o.seller_party_id`,
        [customerUserId, counterpartyType, counterpartyId],
      );

    if (rows.length === 0) return null;
    return {
      counterpartyType: rows[0].counterparty_type,
      counterpartyId: rows[0].counterparty_id,
      lastQualifyingSlotEnd: new Date(rows[0].last_slot_end),
    };
  }
}

/**
 * Who may act on the seller side.
 *
 * ## The owner's second correction
 *
 * For a **business**, this is the owner and `active` staff whose role is
 * `manager`. Engineering proposed "any active staff member"; the owner narrowed
 * it, and the reason is visible in the data: `business_staff.role` is
 * `manager | staff` and nothing finer. An any-active-staff rule would hand a
 * private customer conversation to everyone a salon has ever added — including
 * the practitioner who delivered the service, which sounds right until you notice
 * it also includes everyone else.
 *
 * **The booked practitioner gets no automatic access when their role is only
 * `staff`.** That is the uncomfortable consequence and it is deliberate: the
 * practitioner-specific grant that would fix it properly needs the V3.3-C role
 * matrix, which does not exist. Between "too many people can read it" and "the
 * right person cannot, yet", the second is the recoverable error.
 *
 * For a **professional**, it is the professional's own owning user — the
 * independent case, where there is exactly one person.
 *
 * Everything here is evaluated per request and nothing is stored. A manager
 * deactivated this morning loses the inbox on their next request, not at token
 * expiry.
 */
@Injectable()
export class BusinessBackedChatSellerAccess implements ChatSellerAccessPort {
  async canAccessCounterparty(
    manager: EntityManager,
    userId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<boolean> {
    if (counterpartyType === 'professional') {
      const professional = await manager.getRepository(ProfessionalEntity).findOne({
        where: { id: counterpartyId, ownerId: userId, deletedAt: IsNull() },
        select: { id: true },
      });
      return professional !== null;
    }

    const business = await manager.getRepository(BusinessEntity).findOne({
      where: { id: counterpartyId, ownerId: userId, deletedAt: IsNull() },
      select: { id: true },
    });
    if (business) return true;

    // Active MANAGERS only. `role: 'staff'` is deliberately absent.
    const membership = await manager.getRepository(BusinessStaffEntity).findOne({
      where: { businessId: counterpartyId, userId, status: 'active', role: 'manager' },
      select: { id: true },
    });
    return membership !== null;
  }

  async counterpartiesFor(
    manager: EntityManager,
    userId: string,
  ): Promise<readonly { counterpartyType: ChatCounterpartyType; counterpartyId: string }[]> {
    // Sequential rather than `Promise.all`. Three reads on ONE transaction's
    // manager share one connection and serialise anyway, and issuing them
    // together only risks a driver-level protocol error for no gain.
    const professionals = await manager
      .getRepository(ProfessionalEntity)
      .find({ where: { ownerId: userId, deletedAt: IsNull() }, select: { id: true } });
    const ownedBusinesses = await manager
      .getRepository(BusinessEntity)
      .find({ where: { ownerId: userId, deletedAt: IsNull() }, select: { id: true } });
    const managed = await manager
      .getRepository(BusinessStaffEntity)
      .find({ where: { userId, status: 'active', role: 'manager' }, select: { businessId: true } });

    const businessIds = new Set<string>([
      ...ownedBusinesses.map((b) => b.id),
      ...managed.map((m) => m.businessId),
    ]);

    return [
      ...professionals.map((p) => ({ counterpartyType: 'professional' as const, counterpartyId: p.id })),
      ...[...businessIds].map((id) => ({ counterpartyType: 'business' as const, counterpartyId: id })),
    ];
  }

  /**
   * Who to notify on the seller side.
   *
   * The same rule as access, returned as user ids so `MessageSent` can carry a
   * concrete `recipientUserId` and the notification consumer needs no
   * cross-domain join at dispatch time.
   *
   * A message to a salon therefore notifies the owner and each active manager
   * once — each a separate, individually idempotent notification. A busy salon
   * with four managers produces four notifications for one message, which is the
   * honest behaviour: an inbox shared by four people is four people's inbox.
   */
  async recipientsFor(
    manager: EntityManager,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<readonly string[]> {
    if (counterpartyType === 'professional') {
      const professional = await manager.getRepository(ProfessionalEntity).findOne({
        where: { id: counterpartyId, deletedAt: IsNull() },
        select: { ownerId: true },
      });
      return professional ? [professional.ownerId] : [];
    }

    const business = await manager.getRepository(BusinessEntity).findOne({
      where: { id: counterpartyId, deletedAt: IsNull() },
      select: { ownerId: true },
    });
    const managers = await manager.getRepository(BusinessStaffEntity).find({
      where: { businessId: counterpartyId, status: 'active', role: 'manager' },
      select: { userId: true },
    });

    const recipients = new Set<string>();
    if (business) recipients.add(business.ownerId);
    for (const membership of managers) recipients.add(membership.userId);
    return [...recipients];
  }
}
