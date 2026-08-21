import { EventEnvelope } from '@beauclick/events';
import { contractKey, EventContract, ServiceName } from './event-contract';

export class UnknownEventContractError extends Error {
  constructor(name: string, version: number) {
    super(
      `No registered contract for ${contractKey(name, version)}. ` +
        'Every V3 event must be declared in the catalog before it can be produced or consumed (V3_EVENT_CATALOG.md).',
    );
  }
}

export class EventContractViolationError extends Error {
  readonly issues: string[];
  constructor(name: string, version: number, issues: string[]) {
    super(`Payload does not satisfy contract ${contractKey(name, version)}: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

export class DuplicateEventContractError extends Error {
  constructor(name: string, version: number) {
    super(
      `Contract ${contractKey(name, version)} is already registered. ` +
        'A payload change is a NEW version, never an edit to an existing one -- a consumer pinned to v1 must keep receiving v1.',
    );
  }
}

export class ProducerViolationError extends Error {
  constructor(name: string, version: number, declared: ServiceName, actual: ServiceName) {
    super(
      `${contractKey(name, version)} is produced by "${declared}", but "${actual}" tried to emit it. ` +
        'One event has exactly one producer; a second producer means two services own the same fact.',
    );
  }
}

export interface ConsumerRegistration {
  readonly eventName: string;
  readonly eventVersion: number;
  /**
   * Which service reacts.
   *
   * Deliberately a plain string rather than `ServiceName`: consumers are
   * registered at runtime from the actually-wired handler list, and a handler
   * composed in `apps/api` from two domains' collaborators does not belong to
   * exactly one service. Forcing it into the enum would mean picking a
   * arbitrary owner and recording something untrue.
   */
  readonly consumer: ServiceName | string;
  /** The class/handler doing the work -- what an operator greps for when this consumer misbehaves. */
  readonly handler: string;
  readonly description: string;
}

/**
 * The producer/consumer registry ADR-007 requires to be "a real, queryable
 * artifact, not tribal knowledge".
 *
 * Two things it makes impossible rather than merely discouraged:
 *
 *  1. **Emitting an undeclared or malformed event.** `validate()` is called
 *     on the way into the outbox, inside the producing transaction, so a
 *     payload that violates its own contract fails the business write
 *     instead of landing in the outbox for a consumer to choke on later.
 *
 *  2. **Consuming an event nobody produces.** `assertConsumersHaveProducers()`
 *     runs at boot: a handler registered against a typo'd name or a version
 *     that was never published fails startup, rather than sitting silently
 *     idle in production and being discovered when someone asks why the
 *     notification never arrived. V2's `beauclick/auth/otp_generated` --
 *     a real hook with zero subscribers, found only by grepping the whole
 *     codebase during discovery -- is the inverse of that same blind spot.
 */
export class EventContractRegistry {
  private readonly contracts = new Map<string, EventContract>();
  private readonly consumers: ConsumerRegistration[] = [];

  register(...contracts: EventContract[]): this {
    for (const contract of contracts) {
      const key = contractKey(contract.name, contract.version);
      if (this.contracts.has(key)) {
        throw new DuplicateEventContractError(contract.name, contract.version);
      }
      this.contracts.set(key, contract);
    }
    return this;
  }

  registerConsumer(...registrations: ConsumerRegistration[]): this {
    this.consumers.push(...registrations);
    return this;
  }

  get(name: string, version: number): EventContract {
    const contract = this.contracts.get(contractKey(name, version));
    if (!contract) throw new UnknownEventContractError(name, version);
    return contract;
  }

  has(name: string, version: number): boolean {
    return this.contracts.has(contractKey(name, version));
  }

  /**
   * Parses and returns the payload, throwing on any violation.
   *
   * Returns the PARSED value rather than the input: zod strips unknown keys,
   * so a producer that accidentally spreads a whole entity into a payload
   * publishes only the declared fields. That is a real safety property, not
   * tidiness -- an entity spread is exactly how a `phone`, a `tokenHash`, or
   * an internal note reaches a consumer that should never have seen it.
   */
  validate(name: string, version: number, payload: unknown): Record<string, unknown> {
    const contract = this.get(name, version);
    const result = contract.schema.safeParse(payload);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
      throw new EventContractViolationError(name, version, issues);
    }
    return result.data as Record<string, unknown>;
  }

  /** Validates an inbound envelope for a consumer. Same contract, other direction. */
  validateEnvelope(envelope: EventEnvelope): Record<string, unknown> {
    return this.validate(envelope.eventType, envelope.eventVersion, envelope.payload);
  }

  assertProducer(name: string, version: number, actual: ServiceName): EventContract {
    const contract = this.get(name, version);
    if (contract.producer !== actual) {
      throw new ProducerViolationError(name, version, contract.producer, actual);
    }
    return contract;
  }

  /**
   * Boot-time check: every registered consumer names a real, registered
   * contract. Called by the composition root; a failure is a failure to boot.
   */
  assertConsumersHaveProducers(): void {
    const orphans = this.consumers
      .filter((c) => !this.has(c.eventName, c.eventVersion))
      .map((c) => `${c.consumer}/${c.handler} consumes ${contractKey(c.eventName, c.eventVersion)}`);
    if (orphans.length > 0) {
      throw new Error(
        `Consumers registered against events no producer declares:\n  ${orphans.join('\n  ')}\n` +
          'Either the event name/version is wrong, or the producing service never published it.',
      );
    }
  }

  /** Events declared in the catalog that nothing consumes. Not an error -- analytics-only facts are legitimate -- but worth surfacing. */
  unconsumedEvents(): string[] {
    const consumed = new Set(this.consumers.map((c) => contractKey(c.eventName, c.eventVersion)));
    return Array.from(this.contracts.keys())
      .filter((k) => !consumed.has(k))
      .sort();
  }

  listContracts(): EventContract[] {
    return Array.from(this.contracts.values()).sort((a, b) =>
      contractKey(a.name, a.version).localeCompare(contractKey(b.name, b.version)),
    );
  }

  listConsumers(): ConsumerRegistration[] {
    return [...this.consumers];
  }

  /** Machine-readable dump of the whole catalog -- what the docs generator and the `/health/events` route render. */
  describe(): Array<{
    event: string;
    aggregateType: string;
    producer: ServiceName;
    consumers: Array<{ service: ServiceName | string; handler: string }>;
    idempotency: string;
    description: string;
  }> {
    return this.listContracts().map((c) => ({
      event: contractKey(c.name, c.version),
      aggregateType: c.aggregateType,
      producer: c.producer,
      consumers: this.consumers
        .filter((r) => r.eventName === c.name && r.eventVersion === c.version)
        .map((r) => ({ service: r.consumer, handler: r.handler })),
      idempotency: c.idempotency,
      description: c.description,
    }));
  }
}
