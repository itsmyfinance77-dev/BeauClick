import { EntityManager, EntityTarget } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { assertPayloadHasNoSecrets, EventEnvelope } from './event-envelope';
import { OutboxEventEntityBase } from './outbox-event.entity';

export interface EmitEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion?: number;
  payload: TPayload;
}

/**
 * Writes an outbox row using a CALLER-SUPPLIED EntityManager.
 *
 * The manager argument is not a convenience -- it is the entire point. The
 * caller is inside a transaction that is also performing the business
 * write; passing its manager here is what makes the event and the business
 * fact commit or roll back together. A version of this that opened its own
 * connection would silently reintroduce the dual-write problem the outbox
 * exists to remove, so there is deliberately no such overload.
 */
export async function emitEvent<TPayload extends Record<string, unknown>>(
  manager: EntityManager,
  outboxEntity: EntityTarget<OutboxEventEntityBase>,
  input: EmitEventInput<TPayload>,
): Promise<EventEnvelope<TPayload>> {
  assertPayloadHasNoSecrets(input.payload);

  const repo = manager.getRepository(outboxEntity);
  const row = repo.create({
    id: uuidv7(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    payload: input.payload,
    publishedAt: null,
    attempts: 0,
    lastError: null,
  });
  const saved = await repo.save(row);

  return {
    id: saved.id,
    aggregateType: saved.aggregateType,
    aggregateId: saved.aggregateId,
    eventType: saved.eventType,
    eventVersion: saved.eventVersion,
    payload: input.payload,
    occurredAt: saved.createdAt ?? new Date(),
  };
}
