import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';

import {
  ChatEligibilityPort,
  ChatEligibleRelationship,
  ChatGrantedConversationScope,
  ChatSellerAccessPort,
} from '@beauclick/chat';
import type { ChatCounterpartyType } from '@beauclick/chat-contract';
import {
  BusinessEntity,
  BusinessStaffEntity,
  SCOPED_STAFF_AUTHORIZER,
  ScopedStaffAuthorizerPort,
} from '@beauclick/business';
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
/**
 * What makes a booking QUALIFY, as one SQL predicate.
 *
 * Extracted to module scope by V3.3 Story #109 (`#44c`) so the eligibility port
 * and the practitioner-specific seller-access rule below cannot grow two opinions
 * about it. `V32-DEC-011`'s rule, unchanged: `confirmed`, `completed` and
 * `no_show` qualify outright, and `cancelled` qualifies only when the append-only
 * history proves it once reached `confirmed` -- because `pending` is the one
 * status any authenticated user can create against any professional, so
 * `pending -> cancelled` would otherwise be an eligibility grant anybody could
 * mint at will.
 */
const QUALIFYING_BOOKING_PREDICATE = `
        b.status IN ('confirmed', 'completed', 'no_show')
        OR (
             b.status = 'cancelled'
             AND EXISTS (
               SELECT 1 FROM booking.booking_history h
                WHERE h.booking_id = b.id
                  AND (h.event = 'confirmed' OR h.to_status = 'confirmed')
             )
           )
`;

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
       AND (${QUALIFYING_BOOKING_PREDICATE})
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
  constructor(
    /**
     * V3.3 #109 (`#44c`). The scoped-authority question, asked through the
     * business-owned port bound in `DomainPortsModule`. `chat` still imports no
     * `business` ORM entity; this adapter is the only bridge, and it passes the
     * caller's `manager` so the read joins chat's send transaction rather than
     * taking a second pool connection.
     */
    @Inject(SCOPED_STAFF_AUTHORIZER) private readonly scopedAuthority: ScopedStaffAuthorizerPort,
  ) {}

  async canAccessCounterparty(
    manager: EntityManager,
    userId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
    customerUserId: string,
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

    // Active MANAGERS. `role: 'staff'` is deliberately still absent here -- an
    // any-active-staff rule remains refused (`V32-DEC-010`).
    const membership = await manager.getRepository(BusinessStaffEntity).findOne({
      where: { businessId: counterpartyId, userId, status: 'active', role: 'manager' },
      select: { id: true },
    });
    if (membership) return true;

    /*
     * V3.3 #109 (`#44c`), `V33-DEC-033` R2 -- the booked practitioner, and only
     * for their own conversation.
     *
     * Five conditions, and every one of them is required:
     *
     *  1. a live `practitioner_chat` grant, on an `active` membership of a live
     *     business, with a non-null professional link -- all four re-read by the
     *     authorizer on this request, never cached in a token;
     *  2. the grant's business is the counterparty, which is the order's
     *     SNAPSHOTTED seller party, so a practitioner who changed salon never
     *     reaches the conversation they used to serve;
     *  3. the membership's `professional_id` equals the `professional_id` of a
     *     QUALIFYING booking between this customer and this business -- which is
     *     what makes the authority practitioner-specific rather than salon-wide;
     *  4. the caller is the membership's own user, which is how the authorizer is
     *     asked in the first place;
     *  5. the booking itself qualifies under the unchanged `V32-DEC-011` rule.
     *
     * A manager without a grant already returned true above; a granted
     * practitioner reaching for a colleague's conversation finds no matching
     * professional here and returns false, indistinguishably from a stranger.
     */
    const authorities = await this.scopedAuthority.liveScopedAuthorities(manager, userId, 'practitioner_chat');
    const grantedHere = authorities.filter((authority) => authority.businessId === counterpartyId);
    if (grantedHere.length === 0) return false;

    const practitioners = await this.qualifyingPractitioners(manager, customerUserId, counterpartyId);
    return grantedHere.some((authority) => practitioners.has(authority.professionalId));
  }

  /**
   * The practitioners who delivered a QUALIFYING booking between this customer
   * and this business.
   *
   * One indexed read against the same predicate `BookingBackedChatEligibility`
   * uses, so "qualifying" cannot come to mean two different things.
   */
  private async qualifyingPractitioners(
    manager: EntityManager,
    customerUserId: string,
    businessId: string,
  ): Promise<ReadonlySet<string>> {
    const rows: Array<{ professional_id: string }> = await manager.query(
      `SELECT DISTINCT b.professional_id
         FROM booking.bookings b
         JOIN commerce.orders o
           ON o.source_type = 'booking' AND o.source_id = b.id
        WHERE b.customer_id = $1
          AND o.seller_party_type = 'business'
          AND o.seller_party_id = $2
          AND (${QUALIFYING_BOOKING_PREDICATE})`,
      [customerUserId, businessId],
    );
    return new Set(rows.map((row) => row.professional_id));
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
    customerUserId: string,
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

    /*
     * V3.3 #109 (`#44c`). Granted practitioners are added ONLY for the
     * conversation they may actually read.
     *
     * Scoped to this customer's qualifying practitioners rather than to the
     * business, because a notification is itself a disclosure: telling every
     * granted practitioner that a message arrived would reveal that a
     * conversation they may not open exists at all.
     */
    for (const professionalId of await this.qualifyingPractitioners(manager, customerUserId, counterpartyId)) {
      for (const userId of await this.scopedAuthority.usersWithLiveScopedAuthority(
        manager,
        'practitioner_chat',
        counterpartyId,
        professionalId,
      )) {
        recipients.add(userId);
      }
    }

    return [...recipients];
  }

  /**
   * The individual conversations a `practitioner_chat` grant reaches for this
   * user -- V3.3 Story #109 (`#44c`).
   *
   * Two batched reads and no N+1: the authorizer returns every
   * `(business, professional)` pair the user holds live, and one query turns
   * those into the `(business, customer)` conversations whose qualifying booking
   * that same practitioner delivered. A user with no grant costs one cheap
   * indexed lookup and returns an empty array, which is almost everyone.
   */
  async grantedConversationScopes(
    manager: EntityManager,
    userId: string,
  ): Promise<readonly ChatGrantedConversationScope[]> {
    const authorities = await this.scopedAuthority.liveScopedAuthorities(manager, userId, 'practitioner_chat');
    if (authorities.length === 0) return [];

    // The pair is zipped into one text key so a single `= ANY` covers the whole
    // set. Both halves are uuids this process just read back from its own
    // database -- never anything a caller supplied.
    const keys = authorities.map((authority) => `${authority.businessId}:${authority.professionalId}`);

    const rows: Array<{ counterparty_id: string; customer_id: string }> = await manager.query(
      `SELECT DISTINCT o.seller_party_id AS counterparty_id, b.customer_id
         FROM booking.bookings b
         JOIN commerce.orders o
           ON o.source_type = 'booking' AND o.source_id = b.id
        WHERE o.seller_party_type = 'business'
          AND (o.seller_party_id::text || ':' || b.professional_id::text) = ANY($1::text[])
          AND (${QUALIFYING_BOOKING_PREDICATE})`,
      [keys],
    );

    return rows.map((row) => ({
      counterpartyType: 'business' as const,
      counterpartyId: row.counterparty_id,
      customerUserId: row.customer_id,
    }));
  }
}
