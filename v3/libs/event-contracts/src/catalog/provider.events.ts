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

export const PROVIDER_EVENTS = [
  ProfessionalUpdated,
  ProfessionalVerificationChanged,
  ServiceOfferingUpdated,
  ProfessionalMediaChanged,
];
