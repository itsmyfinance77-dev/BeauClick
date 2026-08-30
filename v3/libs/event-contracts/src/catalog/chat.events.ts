import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Chat's two facts, and the shortness of this file is the point.
 *
 * `V3.2_PHASE_0_DISCOVERY.md` §8.4 caps this at `ConversationStarted` v1 and
 * `MessageSent` v1, "carrying ids and counts and **never a message body**".
 * ADR-032 §1 extends that to every side channel: no prose in an event, a
 * notification payload, an analytics dimension, a metric label, or a log line.
 *
 * Scan the payloads below: every field is a uuid, an integer, an enum member, or
 * an ISO instant. There is no open `z.string()` anywhere, so an author who wanted
 * to attach "just a preview, for the notification" would have to widen a schema
 * in this file — a visible, reviewable act — rather than adding a property to an
 * object literal in a service and having it travel.
 *
 * The stakes are the same as the AI catalog's and the reasoning is identical: an
 * outbox row fans out to analytics, to every registered consumer, and into
 * whatever the relay logs when a dispatch fails.
 *
 * ## Two events, and the ones deliberately absent
 *
 * There is **no report or moderation event**. No consumer justifies one, and a
 * moderation event would carry the reporter's free-text note — which ADR-032
 * keeps out of every channel. Moderation decisions are recorded in
 * `admin.admin_audit_log`, which is the right home for a privileged action and is
 * immutable in a way an outbox row is not.
 *
 * There is **no attachment field**, in either event. Attachments are out of the
 * V3.2-B milestone entirely; adding them later is a `MessageSent` v2, not an
 * edit to v1.
 */

export const ConversationStarted = defineEvent({
  name: 'ConversationStarted',
  version: 1,
  aggregateType: 'chat_conversation',
  producer: 'chat',
  description: 'A customer opened a conversation with the seller party they transacted with.',
  idempotency:
    'conversationId is the natural key, generated once at insert under UNIQUE(customer_user_id, counterparty_type, counterparty_id); a redelivery carries the same id and the analytics fact table dedupes on the source event id.',
  schema: z.object({
    conversationId: uuid(),
    customerUserId: uuid(),
    /**
     * The IMMUTABLE counterparty, copied from the booking's order snapshot.
     *
     * An enum reusing commerce's existing seller-party vocabulary rather than a
     * free string, so a consumer cannot receive a third value and a producer
     * cannot invent one.
     */
    counterpartyType: z.enum(['professional', 'business']),
    counterpartyId: uuid(),
    startedAt: instant(),
  }),
});

export const MessageSent = defineEvent({
  name: 'MessageSent',
  version: 1,
  aggregateType: 'chat_conversation',
  producer: 'chat',
  description: 'One accepted chat message. Carries a length and a sequence; carries no text.',
  idempotency:
    'messageId is the natural key. UNIQUE(conversation_id, sequence) makes a redelivered send unwritable, the notification module holds its own idempotency key, and analytics dedupes on the source event id.',
  schema: z.object({
    conversationId: uuid(),
    messageId: uuid(),
    senderUserId: uuid(),
    /**
     * Who the notification is for.
     *
     * Carried so the notification consumer needs no cross-domain join at
     * dispatch time. On a business-side conversation the sender's message
     * produces one event per authorized recipient, resolved from business-inbox
     * membership at emit time — so a message to a salon notifies the owner and
     * each active manager once, and each of those is a separate, individually
     * idempotent notification.
     */
    recipientUserId: uuid(),
    /** Monotonic within the conversation. The ordering key, never a client timestamp. */
    sequence: z.number().int().positive(),
    /**
     * Unicode code points in the message.
     *
     * A LENGTH, never the text. This is the field somebody would eventually try
     * to widen into a preview; the schema is what stops them doing it silently.
     */
    bodyLength: z.number().int().nonnegative(),
    occurredAt: instant(),
  }),
});

export const CHAT_EVENTS = [ConversationStarted, MessageSent];
