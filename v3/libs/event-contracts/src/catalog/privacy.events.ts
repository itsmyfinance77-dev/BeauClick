import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Contracts for privacy-service (V3.1 Phase E, GAP-22 / GAP-21).
 *
 * THE RULE EVERY PAYLOAD HERE OBEYS: a privacy event carries the FACT that a
 * request changed state, and nothing about what the request contains. No
 * exported document, no counts of what was erased, no phone number, no
 * display name. These events fan out to analytics -- which stores them
 * permanently -- and to notification -- which persists a row per delivery. An
 * event whose job is to announce that somebody's data was destroyed must not
 * be the reason a copy of it survives in two more schemas.
 *
 * `DataErasureCompleted` deliberately has no notification consumer, and that
 * is not an oversight. By the time it is published the subject's phone number
 * no longer exists and their sessions are revoked; there is no channel left to
 * reach them on, and an in-app notification would be addressed to an account
 * nobody can sign into. The "your account will be deleted" message goes out on
 * `DataErasureRequested`, while the grace window is still open and the subject
 * can still act on it -- which is the moment the message is actually useful.
 */

export const DataExportRequested = defineEvent({
  name: 'DataExportRequested',
  version: 1,
  aggregateType: 'data_request',
  producer: 'privacy',
  description: 'A user asked for a copy of their own data. The document has not been generated yet.',
  idempotency:
    'uq_privacy_open_request_per_subject admits one open request of each kind per subject, so a double tap produces one event.',
  schema: z.object({
    requestId: uuid(),
    subjectUserId: uuid(),
    requestedAt: instant(),
  }),
});

export const DataExportCompleted = defineEvent({
  name: 'DataExportCompleted',
  version: 1,
  aggregateType: 'data_request',
  producer: 'privacy',
  description: 'The export document was generated and is downloadable by the subject until it expires.',
  idempotency:
    'Status CAS processing -> ready. A redelivered generation finds no claimable row and produces no second event.',
  schema: z.object({
    requestId: uuid(),
    subjectUserId: uuid(),
    // The subject needs to know how long they have. The SIZE is deliberately
    // absent: a byte count over a personal-data export is a weak but real
    // signal about how much of the platform somebody has used, and analytics
    // has no need for it.
    expiresAt: instant(),
    completedAt: instant(),
  }),
});

export const DataErasureRequested = defineEvent({
  name: 'DataErasureRequested',
  version: 1,
  aggregateType: 'data_request',
  producer: 'privacy',
  description:
    'A user asked to be erased. Nothing has been destroyed: the grace window is open and the request can still be cancelled.',
  idempotency: 'Same partial UNIQUE as the export request.',
  schema: z.object({
    requestId: uuid(),
    subjectUserId: uuid(),
    /** When the window closes. This is the number the notification actually needs to say. */
    executeAfter: instant(),
    requestedAt: instant(),
  }),
});

export const DataErasureCancelled = defineEvent({
  name: 'DataErasureCancelled',
  version: 1,
  aggregateType: 'data_request',
  producer: 'privacy',
  description: 'The subject cancelled their own erasure inside the grace window. Nothing was destroyed.',
  idempotency: 'Status CAS pending -> cancelled. A second cancel matches no row and emits nothing.',
  schema: z.object({
    requestId: uuid(),
    subjectUserId: uuid(),
    cancelledAt: instant(),
  }),
});

export const DataErasureCompleted = defineEvent({
  name: 'DataErasureCompleted',
  version: 1,
  aggregateType: 'data_request',
  producer: 'privacy',
  description:
    'The subject was erased: every module destroyed its identifying link, and what remains is retained by obligation.',
  idempotency: 'Status CAS processing -> completed, inside the same transaction as the erasure itself.',
  schema: z.object({
    requestId: uuid(),
    // Still present, and by this point it identifies nobody -- which is the
    // whole point of anonymization with referential integrity. A consumer
    // needs it to reconcile its own rows against a subject who no longer has
    // a name or a phone number.
    subjectUserId: uuid(),
    /** Which modules reported doing work. Names only -- never counts, never content. */
    modules: z.array(z.string()),
    completedAt: instant(),
  }),
});

export const PRIVACY_EVENTS = [
  DataExportRequested,
  DataExportCompleted,
  DataErasureRequested,
  DataErasureCancelled,
  DataErasureCompleted,
];
