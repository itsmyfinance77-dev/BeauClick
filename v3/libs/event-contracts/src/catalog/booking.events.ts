import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Contracts for the events booking-service already produces (Phase 2).
 * Every schema below was written by reading the actual `emitEvent` call in
 * `booking.service.ts`, not the catalog prose -- where the two disagreed,
 * the code won and the prose is corrected in V3_EVENT_CATALOG.md.
 */

export const BookingCreated = defineEvent({
  name: 'BookingCreated',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'A customer claimed a slot; the booking exists and is holding it, unpaid.',
  idempotency: 'bookingId is the natural key; a consumer must no-op on redelivery.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    serviceId: uuid(),
    slotId: uuid(),
    startAt: instant(),
    status: z.literal('pending'),
  }),
});

export const BookingConfirmed = defineEvent({
  name: 'BookingConfirmed',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'Payment was verified (or a professional confirmed manually); the slot is now booked.',
  idempotency: 'Emitted inside the pending->confirmed status CAS, which succeeds at most once.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    confirmedAt: instant(),
  }),
});

export const BookingCompleted = defineEvent({
  name: 'BookingCompleted',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'The professional marked the service as delivered. The reward-worthy moment, not payment.',
  idempotency: 'confirmed->completed CAS. Consumers must ALSO dedupe on bookingId -- loyalty does so by DB unique constraint.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    serviceId: uuid(),
    completedAt: instant(),
  }),
});

export const BookingCancelled = defineEvent({
  name: 'BookingCancelled',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'A real cancellation by a party. Distinct from BookingExpired -- this one may owe a refund.',
  idempotency: 'Status CAS; the refund consumer additionally rechecks remaining refundable amount > 0.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    slotId: uuid(),
    previousStatus: z.string(),
    cancelledAt: instant(),
    // V3.3 #161 (`#42d`), ADR-051 §7/§8 F5: 'admin' joins the vocabulary --
    // `CAUSE_BY_ACTOR` now maps it to `platform_cancelled` and it drives the
    // customer's remedy choice, exactly as `system` already does.
    actorType: z.enum(['customer', 'professional', 'system', 'admin']),
    actorId: uuid().nullable(),
    reason: z.string().nullable(),
  }),
});

/**
 * V3.3 #161 (`#42d`), ADR-051 §7. The professional's no-show declaration: an
 * immutable fact that moves no money and opens the customer's objection
 * window. Distinct from `BookingCancelled` -- a no-show never emitted an
 * event before this story, since the merged `markNoShow` had no commerce
 * awareness at all.
 */
export const BookingNoShowDeclared = defineEvent({
  name: 'BookingNoShowDeclared',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'The professional declared a no-show at or after the snapshotted grace. Moves no money on its own.',
  idempotency: 'booking_id UNIQUE on booking.no_show_declarations; at most one declaration per booking, ever.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    declaredAt: instant(),
    objectionWindowEndsAt: instant(),
  }),
});

export const BookingRescheduled = defineEvent({
  name: 'BookingRescheduled',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'The booking moved to a different slot while remaining live. Not a status change.',
  idempotency: 'CAS on (status, rescheduleCount); consumers key on (bookingId, rescheduleCount).',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    oldSlotId: uuid(),
    newSlotId: uuid(),
    oldStartAt: instant(),
    newStartAt: instant(),
    rescheduleCount: z.number().int().nonnegative(),
  }),
});

export const BookingExpired = defineEvent({
  name: 'BookingExpired',
  version: 1,
  aggregateType: 'booking',
  producer: 'booking',
  description: 'An unpaid hold lapsed. Never owes a refund -- no money ever moved.',
  idempotency: 'pending->expired CAS.',
  schema: z.object({
    bookingId: uuid(),
    professionalId: uuid(),
    customerId: uuid(),
    slotId: uuid(),
    expiredAt: instant(),
  }),
});

export const BOOKING_EVENTS = [
  BookingCreated,
  BookingConfirmed,
  BookingCompleted,
  BookingCancelled,
  BookingRescheduled,
  BookingExpired,
  BookingNoShowDeclared,
];
