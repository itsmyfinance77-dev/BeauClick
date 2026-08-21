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

export const PROVIDER_EVENTS = [ProfessionalUpdated, ProfessionalVerificationChanged, ServiceOfferingUpdated];
