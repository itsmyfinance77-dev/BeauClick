import { Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import { EventContractRegistry } from '@beauclick/event-contracts';
import { NotificationService } from '@beauclick/notification';
import { AnalyticsIngestionService } from '@beauclick/analytics';
import { formatFullJalaliDate, formatTime, formatToman } from '@beauclick/persian-utils';
import { NotificationEnricher } from './notification-enricher';

/**
 * Which domain facts become a message to a customer.
 *
 * The set is deliberately SMALL. §19 says not to spam users, and the real
 * discipline behind that is: a notification must correspond to something the
 * customer either asked for or genuinely needs to act on. So a booking
 * confirmation, a cancellation, a reschedule, a payment receipt, a tier
 * crossing, and a membership activation — and nothing else. Notably absent:
 * `BookingCreated` (the customer just did it and is looking at the screen),
 * `OrderCreated` (same), `PaymentInitiated` (they are at the gateway),
 * `SearchPerformed`, and every provider-side event.
 */
interface NotificationRule {
  eventType: string;
  templateKey: string;
  channels: Array<'in_app' | 'email' | 'sms'>;
  entityType: string;
  /**
   * What the notification's idempotency key is measured against.
   *
   * The key is `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`, so
   * whatever `entityId` resolves to decides what counts as "the same
   * notification".
   *
   * `entity` -- the domain id, for a fact that happens at most once per
   * entity. A booking is confirmed once, so a redelivered BookingConfirmed
   * collides with itself and does not send twice. This is the default and the
   * common case.
   *
   * `event` -- the source event's id, for a fact that legitimately RECURS for
   * the same subject. A tier change has no entity of its own, so it was keyed
   * on the customer's user id -- which meant every customer received exactly
   * ONE tier notification in their lifetime and every later crossing was
   * silently swallowed as a duplicate. Found by crossing two tiers against the
   * real stack and reading the notification table.
   */
  dedupeBy?: 'entity' | 'event';
  /**
   * Returns null when this particular occurrence should not notify.
   *
   * Takes an `enricher` because the Phase 2 booking contracts carry ids, not
   * display data -- `BookingConfirmed` has a `professionalId` and a
   * `confirmedAt`, but a customer needs the professional's NAME and the
   * APPOINTMENT time. Two ways to close that gap were available: widen the
   * Phase 2 contracts, or join in the composition root. The join is correct
   * here -- a cross-domain lookup is exactly what `apps/api` exists to do,
   * and widening an event payload so one consumer can render a sentence
   * makes every other consumer carry data it never asked for.
   */
  build: (
    payload: Record<string, unknown>,
    enricher: NotificationEnricher,
  ) => Promise<{ userId: string; entityId: string; vars: Record<string, string | number> } | null>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const NOTIFICATION_RULES: NotificationRule[] = [
  {
    eventType: 'BookingConfirmed',
    templateKey: 'booking_confirmed',
    // in_app only. Email and SMS have no verified provider in this
    // environment (GAP-11), and requesting them would fill the dead-letter
    // queue with messages nobody could have delivered.
    channels: ['in_app'],
    entityType: 'booking',
    build: async (p, enricher) => {
      const details = await enricher.bookingDetails(str(p.bookingId), str(p.professionalId));
      // The APPOINTMENT time, not `confirmedAt` -- telling a customer their
      // booking is confirmed "for" the moment we confirmed it would be
      // confidently wrong in a way they would act on.
      const startAt = details.startAt ?? new Date(str(p.confirmedAt));
      return {
        userId: str(p.customerId),
        entityId: str(p.bookingId),
        vars: {
          professionalName: details.professionalName,
          date: formatFullJalaliDate(startAt),
          time: formatTime(startAt),
        },
      };
    },
  },
  {
    eventType: 'BookingCancelled',
    templateKey: 'booking_cancelled',
    channels: ['in_app'],
    entityType: 'booking',
    build: async (p, enricher) => {
      const details = await enricher.bookingDetails(str(p.bookingId), str(p.professionalId));
      return {
        userId: str(p.customerId),
        entityId: str(p.bookingId),
        vars: {
          professionalName: details.professionalName,
          // The appointment that was cancelled, falling back to the
          // cancellation instant only if the slot is already gone.
          date: formatFullJalaliDate(details.startAt ?? new Date(str(p.cancelledAt))),
        },
      };
    },
  },
  {
    eventType: 'BookingRescheduled',
    templateKey: 'booking_rescheduled',
    channels: ['in_app'],
    entityType: 'booking',
    build: async (p, enricher) => {
      // `newStartAt` IS in this payload -- a reschedule is about the time, so
      // the event carries it. No lookup needed for the date.
      const newStart = new Date(str(p.newStartAt));
      const details = await enricher.bookingDetails(str(p.bookingId), str(p.professionalId));
      return {
        userId: str(p.customerId),
        entityId: str(p.bookingId),
        vars: {
          professionalName: details.professionalName,
          date: formatFullJalaliDate(newStart),
          time: formatTime(newStart),
        },
      };
    },
  },
  {
    eventType: 'OrderPaid',
    templateKey: 'payment_succeeded',
    channels: ['in_app'],
    entityType: 'order',
    build: async (p) => ({
      userId: str(p.customerId),
      entityId: str(p.orderId),
      vars: { amountToman: formatToman(num(p.totalToman)) },
    }),
  },
  {
    eventType: 'LoyaltyTierChanged',
    templateKey: 'loyalty_tier_changed',
    channels: ['in_app'],
    entityType: 'loyalty_account',
    // A customer crosses several tiers over their lifetime against one
    // loyalty account. See the interface note.
    dedupeBy: 'event',
    build: async (p, enricher) => {
      const toTier = str(p.toTierSlug);
      // Crossing DOWNWARD to no tier is not good news and is not announced.
      // Tier can only fall if an admin retires a tier or adjusts thresholds,
      // and telling a customer they have been demoted by a configuration
      // change is a message nobody wants to have sent.
      if (!toTier) return null;
      return {
        userId: str(p.userId),
        entityId: str(p.userId),
        // The DISPLAY name, not the slug: the event carries a machine key and
        // the sentence needs Persian.
        vars: { tierName: await enricher.tierName(toTier) },
      };
    },
  },
  {
    eventType: 'MembershipActivated',
    templateKey: 'membership_activated',
    channels: ['in_app'],
    entityType: 'membership',
    // One membership ROW per user, upserted across plan changes -- so the
    // membership id repeats and cannot be the key.
    dedupeBy: 'event',
    build: async (p) => ({
      userId: str(p.userId),
      entityId: str(p.membershipId),
      vars: { planName: str(p.planSlug) },
    }),
  },
  {
    eventType: 'WaitlistOffered',
    templateKey: 'waitlist_offered',
    channels: ['in_app'],
    entityType: 'waitlist_entry',
    build: async (p, enricher) => ({
      userId: str(p.customerId),
      entityId: str(p.entryId),
      vars: {
        professionalName: await enricher.professionalDisplayName(str(p.professionalId)),
        expiresAtTime: formatTime(new Date(str(p.offerExpiresAt))),
      },
    }),
  },

  // ---- privacy (V3.1 Phase E)
  //
  // `DataErasureCompleted` is deliberately NOT here, and its absence is the
  // considered answer rather than an omission. By the time it is published the
  // subject's phone number is a tombstone and every session is revoked -- there
  // is no channel left to reach them on, and an in-app notification would be
  // addressed to an account nobody can sign into. The message that matters goes
  // out on the REQUEST, while the grace window is open and the user can still
  // act on it.
  {
    eventType: 'DataExportRequested',
    templateKey: 'privacy_export_requested',
    channels: ['in_app'],
    entityType: 'data_request',
    build: async (p) => ({ userId: str(p.subjectUserId), entityId: str(p.requestId), vars: {} }),
  },
  {
    eventType: 'DataExportCompleted',
    templateKey: 'privacy_export_ready',
    channels: ['in_app'],
    entityType: 'data_request',
    build: async (p) => ({
      userId: str(p.subjectUserId),
      entityId: str(p.requestId),
      // The DEADLINE, not the completion time. "Your export is ready" is not
      // actionable on its own; "until when" is the part the user has to plan
      // around, and an export that quietly expires unmentioned is an export
      // the subject never got.
      vars: { expiresAtDate: formatFullJalaliDate(new Date(str(p.expiresAt))) },
    }),
  },
  {
    eventType: 'DataErasureRequested',
    templateKey: 'privacy_erasure_requested',
    channels: ['in_app'],
    entityType: 'data_request',
    build: async (p) => ({
      userId: str(p.subjectUserId),
      entityId: str(p.requestId),
      vars: { executeAfterDate: formatFullJalaliDate(new Date(str(p.executeAfter))) },
    }),
  },
  {
    eventType: 'DataErasureCancelled',
    templateKey: 'privacy_erasure_cancelled',
    channels: ['in_app'],
    entityType: 'data_request',
    build: async (p) => ({ userId: str(p.subjectUserId), entityId: str(p.requestId), vars: {} }),
  },
  {
    /**
     * V3.2-B. A new chat message.
     *
     * The only rule in this list that needs NO enricher, and that is by design:
     * `MessageSent` carries `recipientUserId` precisely so the notification side
     * needs no cross-domain join at dispatch time. On a business-side
     * conversation the send path emits one event per authorized recipient, so a
     * message to a salon produces one notification for the owner and one for
     * each active manager.
     *
     * `vars` is EMPTY and the template requires none. There is no variable
     * through which a message body or a sender name could reach a notification
     * -- ADR-032 §1 keeps prose out of notification payloads, and a preview would
     * put the message into a channel the retention and erasure rules do not
     * cover.
     *
     * `entityType: 'chat_message'` rather than `chat_conversation`, and this is
     * the load-bearing line. The idempotency key is
     * `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`, so keying on
     * the conversation would give each recipient exactly ONE chat notification
     * per conversation for its whole life, with every later message silently
     * swallowed as a duplicate. That is not hypothetical -- it is the tier-change
     * bug recorded on `dedupeBy` above, where keying on the customer meant every
     * customer received one tier notification ever.
     */
    eventType: 'MessageSent',
    templateKey: 'chat_message_received',
    // in_app only. Email and SMS have no verified provider (GAP-11), and push is
    // out of the V3.2-B milestone entirely (`CHAT-PUSH`).
    channels: ['in_app'],
    entityType: 'chat_message',
    build: async (p) => ({
      userId: str(p.recipientUserId),
      entityId: str(p.messageId),
      vars: {},
    }),
  },
];

/**
 * Financial-outbox notification rules -- a separate list, deliberately,
 * because these consume events on `financial.outbox_events` (drained by
 * `financial-outbox.relay.ts` on the ISOLATED financial DataSource, never
 * the main relay) and resolve their recipient by PARTY, not by a userId the
 * payload already carries.
 */
export const FINANCIAL_NOTIFICATION_RULES: NotificationRule[] = [
  {
    eventType: 'SettlementRecorded',
    templateKey: 'settlement_recorded',
    channels: ['in_app'],
    entityType: 'settlement',
    build: async (p, enricher) => {
      const userId = await enricher.sellerUserId(str(p.partyType), str(p.partyId));
      if (!userId) return null; // the party's own profile is gone; nobody to tell.
      return { userId, entityId: str(p.settlementId), vars: { amountToman: formatToman(num(p.amountToman)) } };
    },
  },
];

/**
 * Turns a domain event into a notification request.
 *
 * Idempotency is entirely the notification service's: the idempotency key is
 * `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`, so a redelivered
 * event produces the same key and the insert loses. This handler therefore
 * does no dedupe of its own — a second mechanism here would be a second thing
 * to get wrong, and the database constraint is the one that actually holds
 * under concurrency.
 */
@Injectable()
export class NotificationDispatchHandler implements DomainEventHandler {
  private readonly logger = new Logger('NotificationDispatchHandler');

  constructor(
    readonly eventType: string,
    private readonly rule: NotificationRule,
    private readonly notifications: NotificationService,
    private readonly enricher: NotificationEnricher,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const built = await this.rule.build(envelope.payload as Record<string, unknown>, this.enricher);
    if (!built || !built.userId || !built.entityId) return;

    try {
      await this.notifications.notify({
        userId: built.userId,
        templateKey: this.rule.templateKey,
        vars: built.vars,
        entityType: this.rule.entityType,
        // The source event's id for a recurring fact, the domain id
        // otherwise. Both are stable across redeliveries of one event, which
        // is what keeps the idempotency guarantee intact either way.
        entityId: this.rule.dedupeBy === 'event' ? envelope.id : built.entityId,
        channels: this.rule.channels,
      });
    } catch (err) {
      // A notification failure must never roll back or block the fact that
      // caused it. The event has already committed; the customer's booking is
      // confirmed whether or not we managed to tell them. Logged and
      // swallowed so the outbox row is not retried forever for a message
      // whose moment has passed.
      this.logger.error(
        `Notification for ${envelope.eventType} ${envelope.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function buildNotificationHandlers(
  notifications: NotificationService,
  enricher: NotificationEnricher,
): NotificationDispatchHandler[] {
  return NOTIFICATION_RULES.map((rule) => new NotificationDispatchHandler(rule.eventType, rule, notifications, enricher));
}

/** Same handler class, the financial-only rule list -- see FINANCIAL_NOTIFICATION_RULES's own docblock for why it is separate. */
export function buildFinancialNotificationHandlers(
  notifications: NotificationService,
  enricher: NotificationEnricher,
): NotificationDispatchHandler[] {
  return FINANCIAL_NOTIFICATION_RULES.map(
    (rule) => new NotificationDispatchHandler(rule.eventType, rule, notifications, enricher),
  );
}

/**
 * Ingests every contract-registered event into the analytics fact table.
 *
 * ONE handler registered against many event types, rather than a handler per
 * metric. That is the structural difference from V2, where each feature wrote
 * its own `wp_bc_events` row with whatever shape it felt like: here there is
 * exactly one writer, one schema, and one declarative mapping table
 * (`ingestion.service.ts`) saying what is kept from each event.
 *
 * Failure is deliberately SWALLOWED, not rethrown. Analytics is a read model
 * with no business consequence; letting a bad fact row block an outbox event
 * would let a reporting bug stop bookings from being confirmed. The row is
 * simply not recorded and the failure is logged.
 */
@Injectable()
export class AnalyticsIngestionHandler implements DomainEventHandler {
  private readonly logger = new Logger('AnalyticsIngestionHandler');

  constructor(
    readonly eventType: string,
    private readonly ingestion: AnalyticsIngestionService,
    private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    try {
      // Validated against its contract before being recorded: an analytics
      // store full of malformed facts is worse than one missing a few, since
      // nothing downstream can tell the difference.
      this.contracts.validateEnvelope(envelope);
      await this.ingestion.ingest(envelope);
    } catch (err) {
      this.logger.warn(
        `Analytics ingestion skipped for ${envelope.eventType} ${envelope.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function buildAnalyticsHandlers(
  ingestion: AnalyticsIngestionService,
  contracts: EventContractRegistry,
): AnalyticsIngestionHandler[] {
  return ingestion
    .ingestableEventTypes()
    .filter((eventType) => !FINANCIAL_EVENT_TYPES.has(eventType))
    .map((eventType) => new AnalyticsIngestionHandler(eventType, ingestion, contracts));
}

/**
 * The financial-only subset -- registered against the SEPARATE financial
 * relay (`financial-outbox.relay.ts`), never the main one. Excluded from
 * `buildAnalyticsHandlers()` above rather than merely also-included here:
 * a handler registered on both relays would be harmless (the main relay
 * simply never sees a `LedgerEntriesRecorded` row, since it lives on the
 * isolated financial DataSource) but would register the SAME consumer
 * twice against the boot-time contract check, which is confusing to read
 * even though not incorrect.
 */
const FINANCIAL_EVENT_TYPES = new Set(['LedgerEntriesRecorded', 'SettlementRecorded', 'SettlementReversed']);

export function buildFinancialAnalyticsHandlers(
  ingestion: AnalyticsIngestionService,
  contracts: EventContractRegistry,
): AnalyticsIngestionHandler[] {
  return Array.from(FINANCIAL_EVENT_TYPES).map((eventType) => new AnalyticsIngestionHandler(eventType, ingestion, contracts));
}
