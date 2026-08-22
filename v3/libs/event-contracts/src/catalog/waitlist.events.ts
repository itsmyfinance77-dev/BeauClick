import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Contracts for waitlist-service (Phase 4, ADR-024).
 *
 * Deliberately absent: `SlotOpened` and `WaitlistMatched`. The brief that
 * scoped this phase named both, but in this design an "offer" IS the match
 * -- `WaitlistMatcher.offerNextFor()` performs both in one atomic UPDATE
 * (see waitlist.service.ts), so a separate `WaitlistMatched` event would be
 * a byte-for-byte duplicate of `WaitlistOffered` with no independent
 * consumer. `SlotOpened` would exist only to be immediately consumed by the
 * same matcher that already reacts to `BookingCancelled`/`BookingExpired`
 * (which already carry `slotId`) -- inventing it would be redundant
 * plumbing, not a real seam. See V3_PHASE4_IMPLEMENTATION.md §7.
 */

export const WaitlistJoined = defineEvent({
  name: 'WaitlistJoined',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description: 'A customer joined the waitlist for a professional (optionally, one specific service).',
  idempotency: 'entryId is the natural key; uq_waitlist_active_entry prevents a duplicate active join.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
    serviceId: uuid().nullable(),
    joinedAt: instant(),
  }),
});

export const WaitlistOffered = defineEvent({
  name: 'WaitlistOffered',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description:
    'A reopened slot was offered to the earliest eligible waiting entry. The slot is NOT reserved -- GAP-26\'s ' +
    'invariant holds: acceptance still goes through booking-service\'s own atomic claim and can still lose the race.',
  idempotency: 'waiting->offered CAS; uq_waitlist_active_offer_slot prevents two entries being offered the same slot.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
    slotId: uuid(),
    offerExpiresAt: instant(),
  }),
});

export const WaitlistAccepted = defineEvent({
  name: 'WaitlistAccepted',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description: 'The offer was converted into a real booking via booking-service\'s atomic slot claim.',
  idempotency: 'offered->accepted CAS, which succeeds at most once per entryId.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
    slotId: uuid(),
    bookingId: uuid(),
  }),
});

export const WaitlistDeclined = defineEvent({
  name: 'WaitlistDeclined',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description: 'The customer explicitly declined their offer. The slot is still open -- the matcher re-offers it.',
  idempotency: 'offered->declined CAS, which succeeds at most once per entryId.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
    slotId: uuid(),
  }),
});

export const WaitlistExpired = defineEvent({
  name: 'WaitlistExpired',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description: 'An offer lapsed unanswered. The slot is still open -- the matcher re-offers it.',
  idempotency: 'offered->expired CAS, which succeeds at most once per entryId.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
    slotId: uuid(),
  }),
});

export const WaitlistRemoved = defineEvent({
  name: 'WaitlistRemoved',
  version: 1,
  aggregateType: 'waitlist_entry',
  producer: 'waitlist',
  description: 'The customer voluntarily left the waitlist while still waiting (never offered).',
  idempotency: 'waiting->removed CAS, which succeeds at most once per entryId.',
  schema: z.object({
    entryId: uuid(),
    customerId: uuid(),
    professionalId: uuid(),
  }),
});

export const WAITLIST_EVENTS = [
  WaitlistJoined,
  WaitlistOffered,
  WaitlistAccepted,
  WaitlistDeclined,
  WaitlistExpired,
  WaitlistRemoved,
];
