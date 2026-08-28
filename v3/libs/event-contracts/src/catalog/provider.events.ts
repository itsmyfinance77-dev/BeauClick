import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Net-new in Phase 3. V2 had no provider domain event at all: verification
 * status changes reached search only because `VerificationService::transition()`
 * synchronously called `Indexer::sync()` in the same request. That coupling
 * is what these contracts replace -- provider-service now states the fact and
 * has no idea a search index exists.
 */

export const ProfessionalUpdated = defineEvent({
  name: 'ProfessionalUpdated',
  version: 1,
  aggregateType: 'professional',
  producer: 'provider',
  description: 'A professional profile changed in a way that affects how they are found or ranked.',
  idempotency: 'Carries `revision`, a monotonically increasing per-professional counter. A consumer applying an older revision must discard it -- this is what makes an out-of-order delivery safe rather than merely unlikely.',
  schema: z.object({
    professionalId: uuid(),
    revision: z.number().int().positive(),
    displayName: z.string(),
    bio: z.string().nullable(),
    cityId: uuid().nullable(),
    cityName: z.string().nullable(),
    specialtyIds: z.array(uuid()),
    specialtyNames: z.array(z.string()),
    verificationStatus: z.string(),
    isDeleted: z.boolean(),
    updatedAt: instant(),
  }),
});

export const ProfessionalVerificationChanged = defineEvent({
  name: 'ProfessionalVerificationChanged',
  version: 1,
  aggregateType: 'professional',
  producer: 'provider',
  description: 'A verification-status transition, with its actor and reason. The event V2 never had.',
  idempotency: 'Status-transition CAS in provider-service; a transition legally happens once or is rejected.',
  schema: z.object({
    professionalId: uuid(),
    revision: z.number().int().positive(),
    fromStatus: z.string(),
    toStatus: z.string(),
    actorId: uuid().nullable(),
    reason: z.string().nullable(),
    changedAt: instant(),
  }),
});

export const ServiceOfferingUpdated = defineEvent({
  name: 'ServiceOfferingUpdated',
  version: 1,
  aggregateType: 'service_offering',
  producer: 'provider',
  description: 'A bookable service was created, edited, or removed. Drives price facets and service-name search.',
  idempotency: 'Carries the owning professional`s `revision`; the index applies the newest revision only.',
  schema: z.object({
    serviceId: uuid(),
    professionalId: uuid(),
    revision: z.number().int().positive(),
    name: z.string(),
    durationMinutes: z.number().int().positive(),
    priceToman: z.number().int().nonnegative(),
    isDeleted: z.boolean(),
    updatedAt: instant(),
  }),
});

/**
 * V3.1 Phase C.
 *
 * WHY THIS AND NOT `PortfolioItemAdded`, which is the name
 * `V3.1_PRODUCT_ROADMAP.md` §15 proposed. The roadmap's own words for the
 * consumer are "a provider with work shown is a different search result than
 * one without" -- that is a PROJECTION need, and an `-Added` event cannot
 * serve it. It has no way to express an item being removed, an avatar being
 * replaced, or a moderator taking an image down, so each of those would need
 * a sibling event and the consumer would have to reconstruct the current set
 * by replaying all four in order. At-least-once, unordered delivery cannot
 * promise that.
 *
 * `ProfessionalUpdated` already solved this exact problem in Phase 3 and its
 * docblock says why: "A full snapshot plus a revision is self-sufficient: the
 * newest one wins and nothing needs replaying." This is that pattern applied
 * to imagery, and the deviation from the roadmap's proposed name is recorded
 * in `V3.1_PHASE_C_IMPLEMENTATION.md` rather than made silently.
 *
 * It is a SEPARATE event from `ProfessionalUpdated` rather than new fields on
 * it, because adding a field to a v1 contract is forbidden here -- a payload
 * change is a new version, and bumping `ProfessionalUpdated` to v2 would
 * force every one of its consumers through a migration for a change none of
 * them care about.
 */
export const ProfessionalMediaChanged = defineEvent({
  name: 'ProfessionalMediaChanged',
  version: 1,
  aggregateType: 'professional',
  producer: 'provider',
  description: "A professional's avatar, cover, or portfolio changed. Carries the full current imagery, not a diff.",
  idempotency:
    'Carries the same per-professional `revision` counter `ProfessionalUpdated` uses, bumped in the producing transaction. A consumer applying an older revision must discard it.',
  schema: z.object({
    professionalId: uuid(),
    revision: z.number().int().positive(),
    avatarUrl: z.string().nullable(),
    /** Intrinsic dimensions, so a consumer can reserve space without loading the image. */
    avatarWidth: z.number().int().positive().nullable(),
    avatarHeight: z.number().int().positive().nullable(),
    portfolioCount: z.number().int().nonnegative(),
    /** A bounded preview set, not the whole gallery. */
    portfolioPreviewUrls: z.array(z.string()),
    changedAt: instant(),
  }),
});

/**
 * V3.1 Phase D. `V3_DOMAIN_BOUNDARIES.md` §provider named this contract in
 * Phase 0 and search, loyalty, and analytics have referenced it ever since as
 * the thing that would eventually arrive. This is it.
 *
 * WHAT IS DELIBERATELY ABSENT: the review's TEXT. `comment` is free-text,
 * customer-authored, PII-adjacent content, and `V3_DOMAIN_BOUNDARIES.md` §ai
 * names "raw review text" on the excluded-by-construction list. An event
 * payload is the widest distribution channel in this architecture -- it
 * reaches every consumer, is persisted in an outbox, and is replayable -- so
 * putting the prose in it would make that exclusion unenforceable downstream
 * no matter how carefully each individual consumer behaved.
 *
 * The `rating` IS carried, because it is the signal: search cannot maintain
 * `rating_sum` without the number, and re-reading it would mean search
 * depending on provider.
 */
export const ReviewCreated = defineEvent({
  name: 'ReviewCreated',
  version: 1,
  aggregateType: 'review',
  producer: 'provider',
  description: 'A customer reviewed a completed booking. Carries the rating; never the review text.',
  idempotency:
    'A UNIQUE index on `booking_id` means the review exists at most once, so this is emitted at most once per booking. Search additionally guards its counter with `signal_applications` keyed by the outbox row id, because a counter increment is not naturally idempotent.',
  schema: z.object({
    reviewId: uuid(),
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    rating: z.number().int().min(1).max(5),
    createdAt: instant(),
  }),
});

/**
 * V3.1 Phase D, and a DELIBERATE ADDITION beyond the event the roadmap named.
 *
 * The roadmap lists only `ReviewCreated` for this phase. Shipping only that
 * would leave moderation decorative for ranking: a review hidden for abuse
 * would keep its rating in `search.ranking_signals` forever, because the
 * counter was incremented by an event that already happened and nothing would
 * undo it. A provider would then be ranked on reviews no longer visible to the
 * customers deciding whether to book them.
 *
 * That is precisely the QA-18 bug class -- a signal whose writer does not
 * match reality -- which this phase exists to close, so closing half of it
 * would be worse than not noticing. The deviation is recorded in
 * `V3.1_PHASE_D_IMPLEMENTATION.md` rather than made silently.
 *
 * Carries `rating` so the consumer can compensate by exactly the amount that
 * was applied, and `fromStatus`/`toStatus` so a consumer that cares about only
 * one direction can filter without keeping state. The moderator's free-text
 * `reason` is NOT carried -- operator-authored prose, the same exclusion
 * `BookingCancelled` already applies to its own reason.
 */
export const ReviewModerated = defineEvent({
  name: 'ReviewModerated',
  version: 1,
  aggregateType: 'review',
  producer: 'provider',
  description: "A moderator decided a review's visibility. Reverses or restores its ranking contribution.",
  idempotency:
    'Compare-and-swap on the review row, so a transition happens once. Search guards the compensating counter with `signal_applications` under a signal name distinct from the creation one, so a redelivery of either cannot double-apply.',
  schema: z.object({
    reviewId: uuid(),
    professionalId: uuid(),
    rating: z.number().int().min(1).max(5),
    fromStatus: z.string(),
    toStatus: z.string(),
    actorId: uuid(),
    moderatedAt: instant(),
  }),
});

export const PROVIDER_EVENTS = [
  ProfessionalUpdated,
  ProfessionalVerificationChanged,
  ServiceOfferingUpdated,
  ProfessionalMediaChanged,
  ReviewCreated,
  ReviewModerated,
];
