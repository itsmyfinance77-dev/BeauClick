import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import {
  BookingCompleted,
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ReviewCreated,
  ReviewModerated,
  parseEnvelope,
} from '@beauclick/event-contracts';
import { ReviewService } from '@beauclick/provider';
import { SearchIndexerService } from '@beauclick/search';
import { LOYALTY_REASONS, LoyaltyLedgerService, MembershipService } from '@beauclick/loyalty';

/**
 * The review domain's event wiring (V3.1 Phase D).
 *
 *   BookingCompleted -> record review eligibility in the provider domain
 *   ReviewCreated    -> rating signal (QA-18), loyalty points
 *   ReviewModerated  -> compensating rating signal
 *
 * Analytics consumes both review events through the generic ingestion mapping
 * rather than a handler here, the same way every other domain fact reaches it.
 */

/**
 * Makes a completed booking reviewable.
 *
 * This handler is what lets review eligibility be a FOREIGN KEY instead of a
 * synchronous cross-domain read. provider-service cannot query
 * booking-service (ADR-011); it consumes the fact and keeps its own narrow
 * projection of it, which `provider.reviews.booking_id` then references.
 *
 * `V3_DOMAIN_BOUNDARIES.md` §provider has listed `BookingCompleted` under
 * "events consumed — review eligibility" since Phase 0. This is the first
 * consumer to actually implement it.
 */
@Injectable()
export class BookingCompletedEligibilityHandler implements DomainEventHandler {
  readonly eventType = BookingCompleted.name;
  readonly eventVersion = BookingCompleted.version;

  constructor(
    private readonly reviews: ReviewService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, BookingCompleted, envelope);

    // Idempotent by primary key: `booking_id` IS the key, so a redelivery
    // writes nothing and reports nothing wrong.
    await this.reviews.recordEligibility({
      bookingId: payload.bookingId,
      professionalId: payload.professionalId,
      customerId: payload.customerId,
      serviceId: payload.serviceId,
      completedAt: new Date(payload.completedAt),
    });
  }
}

/**
 * The rating signal writer — QA-18's actual fix.
 *
 * The gap register's own words: "The fix is a consumer, not a feature." This
 * is that consumer. `search.ranking_signals.rating_sum` / `.review_count` have
 * existed since Phase 3 with a migration comment saying nothing writes them,
 * and the Bayesian term, the `high_rating` badge, the `minRating` filter and
 * the `rating` sort have all been inert at 0/0 ever since.
 */
@Injectable()
export class ReviewCreatedSearchHandler implements DomainEventHandler {
  readonly eventType = ReviewCreated.name;
  readonly eventVersion = ReviewCreated.version;
  private readonly logger = new Logger('ReviewCreatedSearchHandler');

  constructor(
    private readonly indexer: SearchIndexerService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ReviewCreated, envelope);

    // `envelope.id` is the outbox row id: stable across redeliveries of this
    // event, distinct from every other. A counter increment is the one
    // projection operation that is not naturally idempotent, so applying it
    // twice would leave a permanently wrong average with nothing able to
    // detect it.
    const applied = await this.indexer.applyRatingSignal({
      eventId: envelope.id,
      signalName: 'review_created',
      professionalId: payload.professionalId,
      ratingDelta: payload.rating,
      countDelta: 1,
    });

    if (!applied) this.logger.debug(`Rating already applied for review ${payload.reviewId}`);
  }
}

/**
 * Takes the rating contribution back out when a review is hidden, and puts it
 * back when one is restored.
 *
 * Without this, moderation would be decorative for ranking: a review hidden
 * for abuse would keep influencing the provider's position forever, because
 * the counter was moved by an event that already happened. That is the same
 * class of defect as QA-18 itself, which is why closing only half of it would
 * have been worse than not noticing.
 */
@Injectable()
export class ReviewModeratedSearchHandler implements DomainEventHandler {
  readonly eventType = ReviewModerated.name;
  readonly eventVersion = ReviewModerated.version;

  constructor(
    private readonly indexer: SearchIndexerService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ReviewModerated, envelope);

    const hiding = payload.toStatus === 'hidden';
    await this.indexer.applyRatingSignal({
      eventId: envelope.id,
      // Distinct signal names, so a `ReviewCreated` and a `ReviewModerated`
      // for the same review occupy different rows in `signal_applications`
      // and neither can suppress the other.
      signalName: hiding ? 'review_hidden' : 'review_restored',
      professionalId: payload.professionalId,
      ratingDelta: hiding ? -payload.rating : payload.rating,
      countDelta: hiding ? -1 : 1,
    });
  }
}

/**
 * Points for writing a review.
 *
 * `LOYALTY_POINTS_REVIEW_SUBMITTED` has been configured at 5 since Phase 3 and
 * has never been awardable, because no review domain existed to trigger it.
 * The gap register calls this out by name.
 *
 * Modelled exactly on `BookingCompletedLoyaltyHandler`, including the early
 * return: a duplicate delivery returns `awarded: false` from the ledger's
 * UNIQUE index and must NOT re-run the membership sync, which would otherwise
 * re-activate and re-emit on every redelivery.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: claw the points back when a review is
 * later hidden. Whether abuse should cost a customer their points is a policy
 * question nobody has answered, and the ledger has no reversal path built. It
 * is recorded as a product decision rather than settled by whichever behaviour
 * was easier to implement.
 */
@Injectable()
export class ReviewCreatedLoyaltyHandler implements DomainEventHandler {
  readonly eventType = ReviewCreated.name;
  readonly eventVersion = ReviewCreated.version;
  private readonly logger = new Logger('ReviewCreatedLoyaltyHandler');

  constructor(
    private readonly ledger: LoyaltyLedgerService,
    private readonly memberships: MembershipService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ReviewCreated, envelope);

    const result = await this.ledger.award({
      userId: payload.customerId,
      reason: LOYALTY_REASONS.reviewSubmitted,
      referenceType: 'review',
      referenceId: payload.reviewId,
    });

    if (!result.awarded) {
      this.logger.debug(`Points already awarded for review ${payload.reviewId}`);
      return;
    }

    await this.memberships.syncFromTier(payload.customerId, result.lifetimeEarned);
  }
}
