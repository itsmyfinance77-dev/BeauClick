import { z } from 'zod';

/**
 * V3_EVENT_CATALOG.md, made executable.
 *
 * Phase 2 gave every event a name and an integer version, but the payload
 * was `Record<string, unknown>` all the way from the producer to the
 * consumer -- so "producer changed shape" and "consumer reads a field that
 * no longer exists" were both silent at compile time AND at run time. The
 * catalog said what a payload should contain; nothing checked that it did.
 *
 * A contract makes the catalog entry the single artifact that defines:
 *   - the event's name and version (the wire identity),
 *   - the aggregate it is about,
 *   - the ONE service allowed to produce it,
 *   - the payload's runtime schema, from which its TypeScript type is
 *     DERIVED rather than declared separately (so the two cannot drift),
 *   - the documented idempotency strategy every consumer must implement.
 *
 * Deriving the type from the schema is the load-bearing choice. A
 * hand-written `interface` next to a hand-written validator is two
 * declarations of one truth, and they diverge the first time somebody edits
 * only one. `z.infer` makes divergence unrepresentable.
 */
export type ServiceName =
  | 'identity'
  | 'provider'
  | 'booking'
  | 'commerce'
  | 'payment'
  | 'financial'
  | 'search'
  | 'loyalty'
  | 'journey'
  | 'notification'
  | 'analytics'
  | 'business'
  | 'waitlist'
  | 'privacy';

export interface EventContract<TSchema extends z.ZodType = z.ZodType> {
  /** Wire name, e.g. `BookingCompleted`. Unique per version. */
  readonly name: string;
  /** Integer version. A breaking payload change is a NEW version, never an edit. */
  readonly version: number;
  /** The aggregate root this event is about -- `booking`, `order`, `professional`, ... */
  readonly aggregateType: string;
  /** Exactly one service may produce a given event. Enforced at emit time. */
  readonly producer: ServiceName;
  readonly schema: TSchema;
  /** Why the event exists, in one line -- shown by `describe()`. */
  readonly description: string;
  /**
   * How a consumer must survive redelivery. The outbox is at-least-once, so
   * this is not documentation -- it is the contract a consumer signs by
   * registering. Stated per event because the right mechanism differs
   * (natural key, DB unique constraint, status CAS, remaining-amount recheck).
   */
  readonly idempotency: string;
}

/** The payload type of a contract, derived from its schema. */
export type PayloadOf<C extends EventContract> = z.infer<C['schema']>;

export function defineEvent<TSchema extends z.ZodType>(
  contract: EventContract<TSchema>,
): EventContract<TSchema> {
  return Object.freeze(contract);
}

/** `Name@version` -- the registry key and the string used in every log line. */
export function contractKey(name: string, version: number): string {
  return `${name}@v${version}`;
}
