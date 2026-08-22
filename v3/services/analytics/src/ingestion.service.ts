import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEnvelope, insertOnce, logOperation } from '@beauclick/events';
import { AnalyticsEventEntity, AnalyticsSubjectType } from './entities/analytics.entities';
import { platformCalendarDay } from './platform-day';

/**
 * How one event type becomes a fact row.
 *
 * A declarative mapping rather than a switch statement, so "which events does
 * analytics ingest, and what does it keep from each" is answerable by reading
 * one table instead of tracing branches. Adding an event means adding a row.
 *
 * The `dimensions` function is where the privacy boundary lives, and it is
 * an ALLOW-LIST by construction: it names the fields to keep. A payload field
 * nobody listed does not reach the fact table, so a producer adding a field
 * cannot silently start feeding it into analytics.
 */
interface FactMapping {
  subjectType: AnalyticsSubjectType | null;
  subjectOf: (payload: Record<string, unknown>) => string | null;
  actorOf?: (payload: Record<string, unknown>) => string | null;
  metricOf?: (payload: Record<string, unknown>) => number | null;
  dimensions?: (payload: Record<string, unknown>) => Record<string, string | number | boolean | null>;
  timestampOf?: (payload: Record<string, unknown>) => string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const FACT_MAPPINGS: Record<string, FactMapping> = {
  // ---- booking funnel
  BookingCreated: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    dimensions: (p) => ({ serviceId: str(p.serviceId) }),
  },
  BookingConfirmed: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    timestampOf: (p) => str(p.confirmedAt),
  },
  BookingCompleted: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    dimensions: (p) => ({ serviceId: str(p.serviceId) }),
    timestampOf: (p) => str(p.completedAt),
  },
  BookingCancelled: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    // WHO cancelled is the analytically interesting part -- a
    // professional-initiated cancellation and a customer-initiated one mean
    // opposite things about the provider. The free-text `reason` is NOT
    // carried: it is operator- or customer-authored prose.
    dimensions: (p) => ({ actorType: str(p.actorType), previousStatus: str(p.previousStatus) }),
    timestampOf: (p) => str(p.cancelledAt),
  },
  BookingExpired: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    timestampOf: (p) => str(p.expiredAt),
  },
  BookingRescheduled: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.customerId),
    dimensions: (p) => ({ rescheduleCount: num(p.rescheduleCount) }),
  },

  // ---- commerce funnel
  OrderCreated: {
    subjectType: 'order',
    subjectOf: (p) => str(p.orderId),
    actorOf: (p) => str(p.customerId),
    metricOf: (p) => num(p.totalToman),
    dimensions: (p) => ({ sourceType: str(p.sourceType), sellerPartyId: str(p.sellerPartyId) }),
  },
  OrderPaid: {
    subjectType: 'order',
    subjectOf: (p) => str(p.orderId),
    actorOf: (p) => str(p.customerId),
    metricOf: (p) => num(p.totalToman),
    dimensions: (p) => ({ sourceType: str(p.sourceType), sellerPartyId: str(p.sellerPartyId) }),
    timestampOf: (p) => str(p.paidAt),
  },
  OrderRefunded: {
    subjectType: 'order',
    subjectOf: (p) => str(p.orderId),
    metricOf: (p) => num(p.refundAmountToman),
    timestampOf: (p) => str(p.refundedAt),
  },

  // ---- search & discovery
  SearchPerformed: {
    subjectType: 'search',
    subjectOf: (p) => str(p.searchId),
    actorOf: (p) => str(p.userId),
    metricOf: (p) => num(p.resultCount),
    // Note what is here and what cannot be: the contract has no query-text
    // field, so there is nothing to accidentally carry through.
    dimensions: (p) => ({
      queryClass: str(p.queryClass),
      queryTermCount: num(p.queryTermCount),
      sort: str(p.sort),
      page: num(p.page),
      degraded: typeof p.degraded === 'boolean' ? p.degraded : null,
      filterCount: Array.isArray(p.filterKeys) ? p.filterKeys.length : 0,
    }),
    timestampOf: (p) => str(p.occurredAt),
  },
  ProviderProfileViewed: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ source: str(p.source) }),
    timestampOf: (p) => str(p.occurredAt),
  },

  // ---- loyalty
  LoyaltyPointsEarned: {
    subjectType: 'customer',
    subjectOf: (p) => str(p.userId),
    actorOf: (p) => str(p.userId),
    metricOf: (p) => num(p.points),
    // `lifetimeEarned` is deliberately NOT carried: it is a running total
    // about one identifiable customer, and analytics has no question that
    // needs it which the per-award sum cannot answer.
    dimensions: (p) => ({ reason: str(p.reason) }),
    timestampOf: (p) => str(p.earnedAt),
  },
  LoyaltyTierChanged: {
    subjectType: 'customer',
    subjectOf: (p) => str(p.userId),
    dimensions: (p) => ({ fromTier: str(p.fromTierSlug), toTier: str(p.toTierSlug) }),
    timestampOf: (p) => str(p.changedAt),
  },
  MembershipActivated: {
    subjectType: 'membership',
    subjectOf: (p) => str(p.membershipId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ planSlug: str(p.planSlug), source: str(p.source) }),
    timestampOf: (p) => str(p.activatedAt),
  },
  MembershipEnded: {
    subjectType: 'membership',
    subjectOf: (p) => str(p.membershipId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ reason: str(p.reason) }),
    timestampOf: (p) => str(p.endedAt),
  },

  // ---- notification delivery
  // Message CONTENT is never carried -- only the category, channel, and
  // outcome, which is everything a deliverability question actually needs.
  NotificationRequested: {
    subjectType: 'notification',
    subjectOf: (p) => str(p.notificationId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ category: str(p.category), channel: str(p.channel), templateKey: str(p.templateKey) }),
    timestampOf: (p) => str(p.requestedAt),
  },
  NotificationSent: {
    subjectType: 'notification',
    subjectOf: (p) => str(p.notificationId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ category: str(p.category), channel: str(p.channel), attempts: num(p.attempts) }),
    timestampOf: (p) => str(p.sentAt),
  },
  NotificationFailed: {
    subjectType: 'notification',
    subjectOf: (p) => str(p.notificationId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ category: str(p.category), channel: str(p.channel), errorCode: str(p.errorCode) }),
    timestampOf: (p) => str(p.failedAt),
  },
  NotificationDeadLettered: {
    subjectType: 'notification',
    subjectOf: (p) => str(p.notificationId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ category: str(p.category), channel: str(p.channel), errorCode: str(p.errorCode) }),
    timestampOf: (p) => str(p.deadLetteredAt),
  },
  NotificationRead: {
    subjectType: 'notification',
    subjectOf: (p) => str(p.notificationId),
    actorOf: (p) => str(p.userId),
    dimensions: (p) => ({ category: str(p.category) }),
    timestampOf: (p) => str(p.readAt),
  },

  // ---- provider lifecycle
  ProfessionalVerificationChanged: {
    subjectType: 'provider',
    subjectOf: (p) => str(p.professionalId),
    actorOf: (p) => str(p.actorId),
    // `reason` is operator-authored free text and is not carried.
    dimensions: (p) => ({ fromStatus: str(p.fromStatus), toStatus: str(p.toStatus) }),
    timestampOf: (p) => str(p.changedAt),
  },

  // ---- financial (Phase 4: the financial outbox consumer, ADR-025).
  // This is the ONLY way a financial fact can ever reach analytics --
  // financial.ledger_entries and financial.settlement_* are not merely
  // access-controlled, the main application role has REVOKE ALL on the
  // schema entirely (ADR-017). These mappings are drained by a SEPARATE
  // relay bound to FINANCIAL_DATA_SOURCE (financial-outbox.relay.ts), never
  // the main one, for exactly that reason.
  LedgerEntriesRecorded: {
    subjectType: 'order',
    subjectOf: (p) => str(p.orderId),
    metricOf: (p) => num(p.receivableToman),
    // `sellerPartyId` is NOT carried: analytics has no per-seller question
    // this fact needs to answer today, and a seller's own earnings are
    // already visible to them through MyFinanceService -- duplicating that
    // identity into a shared analytics table would be a real party-identity
    // leak for zero product benefit. `sellerPartyType` alone (an aggregate
    // dimension) is safe.
    dimensions: (p) => ({
      referenceType: str(p.referenceType),
      commissionToman: num(p.commissionToman),
      sellerPartyType: str(p.sellerPartyType),
    }),
  },
  // SettlementRecorded/SettlementReversed have no natural existing subject
  // (no 'settlement' entry in AnalyticsSubjectType, and adding one is a
  // schema CHECK-constraint change this phase does not need to make for one
  // dimension-only dashboard question: total settled/reversed amount over
  // time). subjectType stays null; the amount is still a real metric.
  SettlementRecorded: {
    subjectType: null,
    subjectOf: () => null,
    metricOf: (p) => num(p.amountToman),
    dimensions: (p) => ({ partyType: str(p.partyType), orderCount: num(p.orderCount), method: str(p.method) }),
  },
  SettlementReversed: {
    subjectType: null,
    subjectOf: () => null,
    metricOf: (p) => num(p.amountToman),
    dimensions: (p) => ({ partyType: str(p.partyType) }),
  },
};

/**
 * Turns domain events into analytics facts.
 *
 * Ingestion is idempotent by primary key, so a redelivered event is a no-op
 * INSERT rather than a double count. It is also SILENT about events it does
 * not map: an unmapped event type is not an error, because a domain is
 * allowed to publish facts analytics has no question about, and throwing
 * would leave those outbox rows retrying forever.
 */
@Injectable()
export class AnalyticsIngestionService {
  private readonly logger = new Logger('AnalyticsIngestion');

  constructor(
    @InjectRepository(AnalyticsEventEntity) private readonly facts: Repository<AnalyticsEventEntity>,
  ) {}

  isIngestable(eventType: string): boolean {
    return eventType in FACT_MAPPINGS;
  }

  ingestableEventTypes(): string[] {
    return Object.keys(FACT_MAPPINGS).sort();
  }

  /** Returns true when a new fact row was written, false when the event was a duplicate or unmapped. */
  async ingest(envelope: EventEnvelope): Promise<boolean> {
    const mapping = FACT_MAPPINGS[envelope.eventType];
    if (!mapping) return false;

    const payload = envelope.payload as Record<string, unknown>;
    const subjectId = mapping.subjectOf(payload);
    const occurredAt = this.resolveTimestamp(mapping, payload, envelope);

    const inserted = await insertOnce(
      this.facts
      .createQueryBuilder()
      .insert()
      .values({
        // The source event's id. See the entity docblock.
        eventId: envelope.id,
        eventType: envelope.eventType,
        eventVersion: envelope.eventVersion,
        aggregateType: envelope.aggregateType,
        aggregateId: envelope.aggregateId,
        // A mapping declaring a subjectType but finding no id yields NULL for
        // both, satisfying the schema's paired-null constraint rather than
        // writing a half-populated subject nothing can be grouped by.
        subjectType: subjectId ? mapping.subjectType : null,
        subjectId: subjectId ?? null,
        actorId: mapping.actorOf?.(payload) ?? null,
        correlationId: envelope.correlationId ?? null,
        dimensions: this.compact(mapping.dimensions?.(payload) ?? {}) as never,
        metricValue: mapping.metricOf?.(payload) ?? null,
        occurredAt,
        occurredOn: platformCalendarDay(occurredAt),
      }),
      'event_id',
    );

    // `inserted=false` is the normal, correct outcome of a redelivery, not an
    // error -- but it is the only way to see that dedupe is actually doing
    // something, and a sudden run of them is how an upstream retry loop
    // announces itself.
    logOperation(this.logger, 'analytics.ingested', {
      eventType: envelope.eventType,
      eventId: envelope.id,
      subjectType: subjectId ? mapping.subjectType : null,
      inserted,
      occurredOn: platformCalendarDay(occurredAt),
    });

    return inserted;
  }

  /**
   * The event's own timestamp where it has one, falling back to the outbox
   * row's creation time.
   *
   * Using the event's timestamp matters: `occurredOn` drives every daily
   * rollup, and ingestion time can be minutes or (after an outage) hours
   * later. A booking completed at 23:50 must not land on the next day's
   * numbers because the relay was catching up at 00:05.
   */
  private resolveTimestamp(mapping: FactMapping, payload: Record<string, unknown>, envelope: EventEnvelope): Date {
    const declared = mapping.timestampOf?.(payload);
    if (declared) {
      const parsed = new Date(declared);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return envelope.occurredAt ?? new Date();
  }

  /** Drops null dimensions rather than storing them -- a null dimension is a key nothing can group by. */
  private compact(
    dimensions: Record<string, string | number | boolean | null>,
  ): Record<string, string | number | boolean> {
    return Object.fromEntries(
      Object.entries(dimensions).filter(([, v]) => v !== null && v !== undefined),
    ) as Record<string, string | number | boolean>;
  }
}
