import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Notification payloads carry a template KEY and typed variables, never
 * rendered message text.
 *
 * Two reasons, both load-bearing. A rendered Persian sentence in an event
 * payload would be copied into the analytics fact store and every log line
 * that ever touched the envelope -- so "what did we tell this customer"
 * would become permanently readable by every consumer, including ones with
 * no business seeing it. And a template fix would never reach an
 * already-queued notification, because the text was frozen at request time.
 */

export const NOTIFICATION_CATEGORIES = [
  'booking',
  'payment',
  'reminder',
  'waitlist',
  'rebooking',
  'retention',
  'referral',
  'loyalty',
  // V3.1 Phase E. An ADDITIVE widening of a v1 enum, and the one place in this
  // catalogue where that judgement is made rather than a new version cut.
  //
  // The rule this project follows -- "a payload change is a NEW version, never
  // an edit" -- exists to protect deployed consumers. Adding an enum member
  // breaks none: no field changes type, no field is removed, and every value a
  // consumer already understood still arrives. What a v2 would cost is real --
  // every notification contract versioned in lockstep, every consumer pinned
  // forward, for a category label -- and what it would buy is nothing, because
  // the only consumers of `category` here store it or branch on the two
  // mandatory ones.
  //
  // A member REMOVED from this list would be the breaking change, and it would
  // deserve the version.
  'privacy',
  // V3.2-B. Additive on exactly the terms the note above sets out: no existing
  // payload shape changes, no consumer loses a value it understood, and the two
  // mandatory categories the branching consumers care about are untouched.
  // `chat` is deliberately not mandatory -- a message is not operationally
  // required the way a booking confirmation is.
  'chat',
] as const;

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms'] as const;

export const NotificationRequested = defineEvent({
  name: 'NotificationRequested',
  version: 1,
  aggregateType: 'notification',
  producer: 'notification',
  description: 'A notification was accepted for delivery: its idempotency slot is reserved and preferences evaluated.',
  idempotency:
    'UNIQUE(idempotency_key), where the key is {templateKey}:{entityType}:{entityId}:{userId}:{channel} -- V2 exact shape, preserved verbatim.',
  schema: z.object({
    notificationId: uuid(),
    userId: uuid(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    templateKey: z.string(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    entityType: z.string(),
    entityId: uuid(),
    requestedAt: instant(),
  }),
});

export const NotificationSent = defineEvent({
  name: 'NotificationSent',
  version: 1,
  aggregateType: 'notification',
  producer: 'notification',
  description: 'A channel provider accepted the message. Carries no recipient and no body.',
  idempotency: 'Status CAS from pending/failed -> sent on the notification row.',
  schema: z.object({
    notificationId: uuid(),
    userId: uuid(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    templateKey: z.string(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    provider: z.string(),
    attempts: z.number().int().positive(),
    sentAt: instant(),
  }),
});

export const NotificationFailed = defineEvent({
  name: 'NotificationFailed',
  version: 1,
  aggregateType: 'notification',
  producer: 'notification',
  description: 'A delivery attempt failed. `retryable` decides whether the sweep will try again.',
  idempotency: 'Attempt counter increments on the same row; consumers key on (notificationId, attempts).',
  schema: z.object({
    notificationId: uuid(),
    userId: uuid(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    channel: z.enum(NOTIFICATION_CHANNELS),
    // A stable code, never the provider's raw error string -- that can carry
    // a recipient address or an account identifier.
    errorCode: z.string(),
    retryable: z.boolean(),
    attempts: z.number().int().positive(),
    failedAt: instant(),
  }),
});

export const NotificationDeadLettered = defineEvent({
  name: 'NotificationDeadLettered',
  version: 1,
  aggregateType: 'notification',
  producer: 'notification',
  description:
    'Delivery was abandoned -- retries exhausted, or the failure was permanent. The operator-visible end of the line.',
  idempotency: 'Status CAS -> dead_lettered; a row can only leave the retry set once.',
  schema: z.object({
    notificationId: uuid(),
    userId: uuid(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    channel: z.enum(NOTIFICATION_CHANNELS),
    errorCode: z.string(),
    attempts: z.number().int().nonnegative(),
    deadLetteredAt: instant(),
  }),
});

export const NotificationRead = defineEvent({
  name: 'NotificationRead',
  version: 1,
  aggregateType: 'notification',
  producer: 'notification',
  description: 'The recipient opened an in-app notification. Engagement signal only.',
  idempotency: 'CAS on read_at IS NULL -- marking an already-read notification emits nothing.',
  schema: z.object({
    notificationId: uuid(),
    userId: uuid(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    readAt: instant(),
  }),
});

export const NOTIFICATION_EVENTS = [
  NotificationRequested,
  NotificationSent,
  NotificationFailed,
  NotificationDeadLettered,
  NotificationRead,
];
