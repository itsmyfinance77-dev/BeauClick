import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { uuid } from './common';

/**
 * Contracts for the events business-service produces (Phase 4, ADR-023).
 * None of these currently has a reactive consumer -- the staff-invite flow
 * is discovered by the invitee polling `GET /v1/me/business-staff`, not by
 * a notification -- and that is a deliberate Phase 4 scope decision (see
 * V3_PHASE4_IMPLEMENTATION.md §3), not an oversight. They are declared here
 * so they exist as a real, queryable artifact and so analytics can ingest
 * them, exactly as any other unconsumed-but-real fact in this catalog.
 */

export const BusinessCreated = defineEvent({
  name: 'BusinessCreated',
  version: 1,
  aggregateType: 'business',
  producer: 'business',
  description: 'A user created a business profile and became its owner.',
  idempotency: 'businessId is the natural key; a consumer must no-op on redelivery.',
  schema: z.object({
    businessId: uuid(),
    ownerId: uuid(),
    displayName: z.string(),
  }),
});

export const BusinessUpdated = defineEvent({
  name: 'BusinessUpdated',
  version: 1,
  aggregateType: 'business',
  producer: 'business',
  description: 'A business profile was edited.',
  idempotency: 'Emitted on every update; a consumer must key on (businessId, occurredAt) if ordering matters.',
  schema: z.object({ businessId: uuid() }),
});

export const StaffInvited = defineEvent({
  name: 'StaffInvited',
  version: 1,
  aggregateType: 'business_staff',
  producer: 'business',
  description: 'An owner invited a user to join their business staff. Not yet active -- the invitee has not accepted.',
  idempotency: 'staffId is the natural key; uq_business_staff_membership prevents a duplicate invite to the same user.',
  schema: z.object({
    staffId: uuid(),
    businessId: uuid(),
    userId: uuid(),
    role: z.enum(['manager', 'staff']),
    invitedBy: uuid(),
  }),
});

export const StaffAccepted = defineEvent({
  name: 'StaffAccepted',
  version: 1,
  aggregateType: 'business_staff',
  producer: 'business',
  description: 'The invited user accepted; the membership is now active and financial party resolution follows it.',
  idempotency: 'invited->active CAS, which succeeds at most once per staffId.',
  schema: z.object({
    staffId: uuid(),
    businessId: uuid(),
    userId: uuid(),
    role: z.enum(['manager', 'staff']),
  }),
});

export const StaffDeactivated = defineEvent({
  name: 'StaffDeactivated',
  version: 1,
  aggregateType: 'business_staff',
  producer: 'business',
  description: 'A staff membership ended -- removed by the owner, or the member left voluntarily.',
  idempotency: '(invited|active)->inactive CAS, which succeeds at most once per staffId.',
  schema: z.object({
    staffId: uuid(),
    businessId: uuid(),
    userId: uuid(),
  }),
});

export const BUSINESS_EVENTS = [BusinessCreated, BusinessUpdated, StaffInvited, StaffAccepted, StaffDeactivated];
