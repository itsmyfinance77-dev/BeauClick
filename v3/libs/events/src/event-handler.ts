import { EventEnvelope } from './event-envelope';

/**
 * A consumer of one event type.
 *
 * `handle` MUST be idempotent. The outbox guarantees at-least-once
 * delivery, never exactly-once -- a relay that crashes between dispatching
 * and marking a row published will redeliver it, and that is by design
 * (the alternative, marking first, loses events). Every handler in this
 * codebase therefore either writes through a real DB unique constraint or
 * performs a compare-and-swap on a status column; none of them assume they
 * are called exactly once.
 */
export interface DomainEventHandler<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventType: string;
  readonly eventVersion?: number;
  handle(envelope: EventEnvelope<TPayload>): Promise<void>;
}

/** Nest multi-provider token: every module contributes its handlers, the relay consumes all of them. */
export const DOMAIN_EVENT_HANDLERS = Symbol('BEAUCLICK_DOMAIN_EVENT_HANDLERS');
