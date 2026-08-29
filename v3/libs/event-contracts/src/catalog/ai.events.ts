import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * The AI domain's facts — two of them, and the shortness of this file is the
 * point.
 *
 * `V3.2_PRODUCT_ROADMAP.md` and `V3.2_PHASE_0_DISCOVERY.md` §7.4 both cap this
 * at "at most `AIConversationCreated` v1 and `AIMessageSent` v1, carrying ids
 * and counts and no message body". ADR-030 T6 adds the rule these schemas
 * enforce: **no field here is able to hold prose.**
 *
 * That is not a convention. Scan the payloads below: every field is a uuid, an
 * integer, an enum, or an ISO instant. There is no `z.string()` that is not an
 * enum member, so a future author who wanted to attach "just the first sentence,
 * for debugging" would have to widen a schema in this file — a visible,
 * reviewable act — rather than adding a property to an object literal in a
 * service and having it travel.
 *
 * The same discipline `notification` applies to message bodies and `journey` to
 * goal titles. It matters more here: an AI thread can contain a customer's
 * stated beauty and health concerns, and an outbox row fans out to analytics,
 * to every registered consumer, and into whatever a relay logs when a dispatch
 * fails.
 *
 * ## Why only two events
 *
 * Because two have real consumers. `V3.2-A` wires both into the existing
 * analytics fact table, which is what `V32-DEC-009` leaves operators: counts,
 * health, and cost, never content. A `AIRecommendationClicked` event was
 * considered and rejected — the click is recorded on the recommendation row
 * itself, and emitting an event nothing consumes would be publishing because a
 * table changed, which the roadmap explicitly forbids.
 */

export const AIConversationStarted = defineEvent({
  name: 'AIConversationStarted',
  version: 1,
  aggregateType: 'ai_conversation',
  producer: 'ai',
  description: 'A customer opened a new bounded assistant session.',
  idempotency:
    'conversationId is the natural key and is generated once at insert; a redelivery carries the same id, and the analytics fact table dedupes on the source event id.',
  schema: z.object({
    conversationId: uuid(),
    // The OWNER, as an id. Needed so analytics can count distinct users and so
    // an erasure can be reasoned about. An id is not prose, and it points at an
    // identity that erasure destroys -- the same position `analytics.events`
    // already takes for its `actor_id`.
    userId: uuid(),
    startedAt: instant(),
  }),
});

export const AIMessageExchanged = defineEvent({
  name: 'AIMessageExchanged',
  version: 1,
  aggregateType: 'ai_conversation',
  producer: 'ai',
  description:
    'One accepted customer message and its assistant reply. Carries counts and provider mode; carries neither text.',
  idempotency:
    'messageId (the assistant reply) is the natural key. The conversation`s (conversation_id, sequence) unique index makes a redelivered exchange unwritable, and analytics dedupes on the source event id.',
  schema: z.object({
    conversationId: uuid(),
    /** The ASSISTANT message's id. The customer's is deliberately not carried. */
    messageId: uuid(),
    userId: uuid(),
    /**
     * Which provider answered, and what kind of thing it was.
     *
     * An enum, not the provider's key: a key is a configuration value that could
     * one day contain a vendor's name, and an event payload fans out further
     * than a log line does. `simulated` says everything a consumer needs -- that
     * this reply did not come from a real language model.
     */
    providerState: z.enum(['simulated', 'external', 'unavailable']),
    /** Code points in the customer's message. A LENGTH, never the text. */
    inputLength: z.number().int().nonnegative(),
    /** How many recommendations survived independent re-verification. */
    recommendationCount: z.number().int().nonnegative(),
    /**
     * How many the provider named that did NOT survive.
     *
     * Carried because it is the operator's early warning that a provider has
     * started inventing identifiers -- a rising drop rate is visible here long
     * before it becomes a support ticket (ADR-030 T3).
     */
    droppedRecommendationCount: z.number().int().nonnegative(),
    /** Provider latency in milliseconds. Bucketed downstream; raw here. */
    latencyMs: z.number().int().nonnegative(),
    occurredAt: instant(),
  }),
});

export const AI_EVENTS = [AIConversationStarted, AIMessageExchanged];
