import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, EntityTarget, IsNull } from 'typeorm';
import { correlationIdOrNew, runWithCorrelation } from './correlation';
import { EventEnvelope } from './event-envelope';
import { DOMAIN_EVENT_HANDLERS, DomainEventHandler } from './event-handler';
import { OutboxEventEntityBase } from './outbox-event.entity';

/** Nest token: the list of concrete outbox tables the relay should drain. */
export const OUTBOX_SOURCES = Symbol('BEAUCLICK_OUTBOX_SOURCES');

export interface OutboxSource {
  name: string;
  entity: EntityTarget<OutboxEventEntityBase>;
}

export interface DrainResult {
  dispatched: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * Turns committed outbox rows into handler invocations.
 *
 * Transport note (deliberate, disclosed): `ADR-007` names Kafka as V3's
 * event transport. Phase 2 does NOT stand up a broker -- there is no
 * Kafka in this environment and adding one would be Phase 3 infrastructure
 * work masquerading as domain work. What Phase 2 builds instead is the part
 * that actually determines correctness: the transactional outbox, versioned
 * envelopes, and an idempotent-by-contract consumer interface. Swapping
 * this in-process dispatcher for a Kafka producer changes THIS FILE ONLY --
 * no producer writes to a broker directly, and no consumer knows how the
 * envelope reached it.
 *
 * Delivery semantics: **at-least-once**. Rows are dispatched first and
 * marked published second, because the opposite order loses events when a
 * process dies mid-dispatch. A crash between the two therefore redelivers,
 * and two relay instances running concurrently may both pick up the same
 * row. Both are acceptable precisely because `DomainEventHandler.handle`
 * is contractually idempotent -- every handler in this codebase is backed
 * by a real DB unique constraint or a status compare-and-swap.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger('OutboxRelay');
  private readonly handlersByType = new Map<string, DomainEventHandler[]>();
  private draining = false;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject(OUTBOX_SOURCES) private readonly sources: OutboxSource[] = [],
    @Optional() @Inject(DOMAIN_EVENT_HANDLERS) handlers: DomainEventHandler[] = [],
  ) {
    for (const handler of handlers ?? []) {
      const list = this.handlersByType.get(handler.eventType) ?? [];
      list.push(handler);
      this.handlersByType.set(handler.eventType, list);
    }
  }

  /**
   * Drains every registered outbox table once.
   *
   * Called two ways, deliberately: synchronously right after a business
   * transaction commits (so the common path has no added latency and the
   * user sees a consistent result immediately), and periodically by
   * `OutboxSweepScheduler` as the backstop that makes the guarantee real
   * when the fast path was interrupted. The `draining` flag makes
   * overlapping invocations a no-op rather than a second concurrent pass
   * over the same rows.
   */
  async drain(batchSize = DEFAULT_BATCH_SIZE): Promise<DrainResult> {
    if (this.draining) return { dispatched: 0, failed: 0 };
    this.draining = true;
    try {
      let dispatched = 0;
      let failed = 0;
      for (const source of this.sources ?? []) {
        const result = await this.drainSource(source, batchSize);
        dispatched += result.dispatched;
        failed += result.failed;
      }
      return { dispatched, failed };
    } finally {
      this.draining = false;
    }
  }

  private async drainSource(source: OutboxSource, batchSize: number): Promise<DrainResult> {
    const repo = this.dataSource.getRepository(source.entity);
    // UUIDv7 ids sort in creation order, so ordering by id delivers a
    // single aggregate's events in the order they actually happened --
    // without needing a separate sequence column.
    const pending = await repo.find({
      where: { publishedAt: IsNull() },
      order: { id: 'ASC' },
      take: batchSize,
    });

    let dispatched = 0;
    let failed = 0;

    for (const row of pending) {
      // The stored id, not the sweep's own: a handler that emits a further
      // event must produce it under the SAME correlation id, or the chain
      // breaks at exactly the hop that made it worth tracing. This is the one
      // place propagation happens, deliberately -- it is a visible line of
      // code rather than something ambient that happens to work.
      const correlationId = row.correlationId ?? correlationIdOrNew();

      const envelope: EventEnvelope = {
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        payload: row.payload,
        occurredAt: row.createdAt,
        correlationId,
      };

      try {
        await runWithCorrelation(correlationId, async () => {
          for (const handler of this.handlersByType.get(row.eventType) ?? []) {
            await handler.handle(envelope);
          }
        });
        // Compare-and-swap on publishedAt: a concurrent relay that already
        // marked this row simply loses the update, it never double-marks.
        await repo.update({ id: row.id, publishedAt: IsNull() }, { publishedAt: new Date() });
        dispatched += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        // Left UNPUBLISHED on purpose: the next sweep retries it. attempts
        // makes a genuinely poisonous message visible instead of it
        // retrying invisibly forever.
        await repo.update({ id: row.id }, { attempts: row.attempts + 1, lastError: message.slice(0, 1000) });
        this.logger.error(
          `Outbox dispatch failed [${source.name}] ${row.eventType} ${row.id} ` +
            `(attempt ${row.attempts + 1}, correlation ${correlationId}): ${message}`,
        );
      }
    }

    return { dispatched, failed };
  }

  /** Test/diagnostic helper: which event types currently have at least one registered consumer. */
  registeredEventTypes(): string[] {
    return Array.from(this.handlersByType.keys()).sort();
  }
}
