import { EntityManager, EntityTarget } from 'typeorm';
import { emitEvent, EventEnvelope, OutboxEventEntityBase } from '@beauclick/events';
import { EventContract, PayloadOf } from './event-contract';
import { EventContractRegistry } from './registry';

/**
 * The only way a Phase 3 producer writes an event.
 *
 * `emitEvent` (Phase 2) takes a free-text `eventType` and an untyped
 * payload; it is still what actually writes the outbox row, and this
 * function delegates to it. What this adds is the three checks that turn a
 * catalog entry from prose into a mechanism:
 *
 *  1. **The contract must be registered.** An unknown (name, version) throws,
 *     so a typo in an event name fails at the producing transaction instead
 *     of writing a row no consumer will ever match.
 *
 *  2. **The producer must be the declared one.** Two services emitting the
 *     same event means two services own one fact, and a consumer can no
 *     longer reason about who to ask when it looks wrong.
 *
 *  3. **The payload must satisfy the schema, and is REPLACED by the parsed
 *     result.** Unknown keys are stripped rather than passed through. That
 *     is a safety property, not tidiness: an accidental entity spread is
 *     exactly how a `phone`, a `tokenHash`, or a private note reaches a
 *     consumer that should never have seen it. The Phase 2 secret deny-list
 *     still runs underneath as the second, independent layer -- it catches
 *     a secret in a field the contract genuinely declares, which stripping
 *     by definition cannot.
 *
 * The caller's EntityManager is passed straight through, so the event still
 * commits or rolls back with the business fact. Nothing about the outbox's
 * transactional guarantee changes.
 */
export async function emitContractEvent<C extends EventContract>(
  registry: EventContractRegistry,
  manager: EntityManager,
  outboxEntity: EntityTarget<OutboxEventEntityBase>,
  contract: C,
  input: { aggregateId: string; payload: PayloadOf<C> },
): Promise<EventEnvelope> {
  registry.assertProducer(contract.name, contract.version, contract.producer);
  const validated = registry.validate(contract.name, contract.version, input.payload);

  return emitEvent(manager, outboxEntity, {
    aggregateType: contract.aggregateType,
    aggregateId: input.aggregateId,
    eventType: contract.name,
    eventVersion: contract.version,
    payload: validated,
  });
}

/**
 * The consumer-side counterpart: parse an inbound envelope against its
 * contract and hand the handler a typed payload.
 *
 * A handler that reaches into `envelope.payload` directly is reading
 * `Record<string, unknown>` and casting; a handler that goes through this
 * gets a value the schema has actually vouched for. The difference shows up
 * when a producer is at v2 and this consumer still expects v1 -- here that
 * is a loud, specific failure naming the field, rather than an `undefined`
 * quietly flowing into a database column.
 */
export function parseEnvelope<C extends EventContract>(
  registry: EventContractRegistry,
  contract: C,
  envelope: EventEnvelope,
): PayloadOf<C> {
  if (envelope.eventType !== contract.name || envelope.eventVersion !== contract.version) {
    throw new Error(
      `Handler for ${contract.name}@v${contract.version} received ${envelope.eventType}@v${envelope.eventVersion}. ` +
        'The relay dispatched an envelope to a handler registered for a different contract.',
    );
  }
  return registry.validate(contract.name, contract.version, envelope.payload) as PayloadOf<C>;
}
