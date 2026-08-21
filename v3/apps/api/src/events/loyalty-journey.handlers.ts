import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import {
  BookingCancelled,
  EVENT_CONTRACT_REGISTRY,
  BookingCompleted,
  BookingConfirmed,
  EventContractRegistry,
  LoyaltyTierChanged,
  MembershipActivated,
  OrderPaid,
  parseEnvelope,
} from '@beauclick/event-contracts';
import { LOYALTY_REASONS, LoyaltyLedgerService, MembershipService } from '@beauclick/loyalty';
import { JourneyService } from '@beauclick/journey';

/**
 * Loyalty earning, and the journey timeline.
 *
 *   BookingCompleted -> award points, then sync tier-linked membership
 *   OrderPaid        -> award points for NON-booking orders only
 *   Booking* / OrderPaid / LoyaltyTierChanged / MembershipActivated
 *                    -> append the customer's timeline entry
 */

/**
 * Points for a completed booking.
 *
 * Consumes `BookingCompleted`, not `OrderPaid` — the service being DELIVERED
 * is the reward-worthy moment, not the money moving. V2 drew this line
 * deliberately and it is preserved.
 */
@Injectable()
export class BookingCompletedLoyaltyHandler implements DomainEventHandler {
  readonly eventType = BookingCompleted.name;
  readonly eventVersion = BookingCompleted.version;
  private readonly logger = new Logger('BookingCompletedLoyaltyHandler');

  constructor(
    private readonly ledger: LoyaltyLedgerService,
    private readonly memberships: MembershipService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, BookingCompleted, envelope);

    const result = await this.ledger.award({
      userId: payload.customerId,
      reason: LOYALTY_REASONS.bookingCompleted,
      referenceType: 'booking',
      referenceId: payload.bookingId,
    });

    // A duplicate delivery returns awarded:false from the UNIQUE index and
    // stops here -- crucially WITHOUT re-running the membership sync, which
    // would otherwise re-activate and re-emit on every redelivery.
    if (!result.awarded) {
      this.logger.debug(`Points already awarded for booking ${payload.bookingId}`);
      return;
    }

    await this.memberships.syncFromTier(payload.customerId, result.lifetimeEarned);
  }
}

/**
 * Points for a paid order.
 *
 * **Excludes booking-linked orders**, and that exclusion is the whole reason
 * this handler needs care. A booking produces BOTH an `OrderPaid` and, later,
 * a `BookingCompleted`; awarding on both would pay a customer twice for one
 * transaction. V2 handled this by simply not firing its shop-order hook for
 * booking orders — an implicit property of the wiring. Here it is an explicit,
 * testable branch on `sourceType`, which is what the event catalog asks for.
 */
@Injectable()
export class OrderPaidLoyaltyHandler implements DomainEventHandler {
  readonly eventType = OrderPaid.name;
  readonly eventVersion = OrderPaid.version;

  constructor(
    private readonly ledger: LoyaltyLedgerService,
    private readonly memberships: MembershipService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, OrderPaid, envelope);

    // The double-counting guard. See this class's docblock.
    if (payload.sourceType === 'booking') return;

    const result = await this.ledger.award({
      userId: payload.customerId,
      reason: LOYALTY_REASONS.orderCompleted,
      referenceType: 'order',
      referenceId: payload.orderId,
    });
    if (!result.awarded) return;

    await this.memberships.syncFromTier(payload.customerId, result.lifetimeEarned);
  }
}

/**
 * The journey timeline.
 *
 * One handler per source event, all writing through `appendTimeline`, which is
 * idempotent by `UNIQUE(user_id, entry_type, source_type, source_id)`. The
 * entry_type is part of that key because one booking legitimately produces
 * several entries over its life (confirmed, completed, cancelled) that share
 * a source id.
 *
 * This is what replaces V2's read-time composition over two other plugins'
 * tables — and with it, the workaround its own docblock describes, where
 * booking events carried no actor_id so the composer had to fetch the
 * customer's booking ids first and match against that set.
 */
@Injectable()
export class TimelineHandler implements DomainEventHandler {
  private readonly logger = new Logger('TimelineHandler');

  constructor(
    readonly eventType: string,
    private readonly entryType: string,
    private readonly sourceType: string,
    /**
     * What the timeline's uniqueness is measured against.
     *
     * `entity` -- the domain id, for facts that happen at most once per
     * entity. A booking is completed once, so `bookingId` is the right key
     * and a redelivery collides with itself.
     *
     * `event` -- the outbox row's id, for facts that legitimately RECUR for
     * the same entity. A customer crosses bronze->silver->gold against one
     * loyalty account; keying those on the account id would record the first
     * crossing and silently swallow every later one. The event id is stable
     * across redeliveries of one event and distinct between different events,
     * so it dedupes exactly as intended in both directions.
     */
    private readonly dedupeBy: 'entity' | 'event',
    private readonly extract: (payload: Record<string, unknown>) => {
      userId: string | null;
      sourceId: string | null;
      metadata?: Record<string, unknown>;
      occurredAt?: string | null;
    },
    private readonly journey: JourneyService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const { userId, sourceId, metadata, occurredAt } = this.extract(envelope.payload as Record<string, unknown>);
    // A fact about nobody is not a timeline entry. Returning rather than
    // throwing keeps a legitimately user-less event from poisoning its
    // outbox row forever.
    if (!userId || !sourceId) return;

    await this.journey.appendTimelineStandalone({
      userId,
      entryType: this.entryType,
      sourceType: this.sourceType,
      sourceId: this.dedupeBy === 'event' ? envelope.id : sourceId,
      // The domain id is preserved in metadata when the event id is the key,
      // so a deep link still has something real to point at.
      metadata: this.dedupeBy === 'event' ? { ...(metadata ?? {}), entityId: sourceId } : (metadata ?? {}),
      occurredAt: occurredAt ? new Date(occurredAt) : (envelope.occurredAt ?? new Date()),
    });
  }
}

/**
 * Builds every timeline handler.
 *
 * A factory rather than a dozen classes: they differ only in which fields to
 * read, and a dozen near-identical classes would make it harder, not easier,
 * to see what the timeline actually contains.
 *
 * Note what each `extract` carries into `metadata`: ids and enums only. No
 * free text, no money the customer has not already seen on their own receipt,
 * and nothing about another party beyond the professional they booked with.
 */
export function buildTimelineHandlers(journey: JourneyService): TimelineHandler[] {
  return [
    new TimelineHandler(
      BookingConfirmed.name,
      'booking_confirmed',
      'booking',
      'entity',
      (p) => ({
        userId: (p.customerId as string) ?? null,
        sourceId: (p.bookingId as string) ?? null,
        metadata: { professionalId: p.professionalId },
        occurredAt: (p.confirmedAt as string) ?? null,
      }),
      journey,
    ),
    new TimelineHandler(
      BookingCompleted.name,
      'booking_completed',
      'booking',
      'entity',
      (p) => ({
        userId: (p.customerId as string) ?? null,
        sourceId: (p.bookingId as string) ?? null,
        metadata: { professionalId: p.professionalId, serviceId: p.serviceId },
        occurredAt: (p.completedAt as string) ?? null,
      }),
      journey,
    ),
    new TimelineHandler(
      BookingCancelled.name,
      'booking_cancelled',
      'booking',
      'entity',
      (p) => ({
        userId: (p.customerId as string) ?? null,
        sourceId: (p.bookingId as string) ?? null,
        // `reason` is deliberately absent: it can be operator-authored free
        // text, and a customer's own timeline is not where that belongs.
        metadata: { professionalId: p.professionalId, actorType: p.actorType },
        occurredAt: (p.cancelledAt as string) ?? null,
      }),
      journey,
    ),
    new TimelineHandler(
      OrderPaid.name,
      'order_paid',
      'order',
      'entity',
      (p) => ({
        userId: (p.customerId as string) ?? null,
        sourceId: (p.orderId as string) ?? null,
        metadata: { totalToman: p.totalToman, sourceType: p.sourceType },
        occurredAt: (p.paidAt as string) ?? null,
      }),
      journey,
    ),
    new TimelineHandler(
      LoyaltyTierChanged.name,
      'loyalty_tier_changed',
      'loyalty_account',
      // A customer crosses several tiers over their lifetime against one
      // loyalty account, so the event id is the key. See TimelineHandler.
      'event',
      (p) => ({
        userId: (p.userId as string) ?? null,
        sourceId: (p.userId as string) ?? null,
        metadata: { toTier: p.toTierSlug, fromTier: p.fromTierSlug },
        occurredAt: (p.changedAt as string) ?? null,
      }),
      journey,
    ),
    new TimelineHandler(
      MembershipActivated.name,
      'membership_activated',
      'membership',
      // One membership ROW per user, upserted across plan changes -- so the
      // membership id repeats and cannot be the key.
      'event',
      (p) => ({
        userId: (p.userId as string) ?? null,
        sourceId: (p.membershipId as string) ?? null,
        metadata: { planSlug: p.planSlug, source: p.source },
        occurredAt: (p.activatedAt as string) ?? null,
      }),
      journey,
    ),
  ];
}
