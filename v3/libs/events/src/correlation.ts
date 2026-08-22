import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from 'uuidv7';

/**
 * V3_EVENT_CATALOG.md requires every event to carry a correlation ID: the
 * identifier that ties one customer action to everything it caused.
 *
 * That requirement is easy to state and easy to lose. A single completed
 * booking now fans out to five independent consumers (ledger, loyalty,
 * journey timeline, notification, analytics), several of which emit further
 * events of their own. Without a correlation ID, "why did this customer get
 * this notification" is answered by comparing timestamps across five schemas
 * and hoping nothing else happened in the same second.
 *
 * ## Why AsyncLocalStorage rather than a parameter
 *
 * The explicit alternative -- thread a `correlationId` argument through every
 * service method -- is more honest to read and strictly worse in practice:
 * it must be passed correctly at every call site, forever, and the failure
 * mode of forgetting is a null column that nobody notices. This codebase has
 * already found three separate guarantees that were upheld "by remembering"
 * and were not actually being upheld (GAP-01, GAP-08, and V2's journey notes
 * rule).
 *
 * The trade-off is stated rather than hidden: ambient context is invisible at
 * the call site. It is mitigated by making the DURABLE record the outbox
 * column -- once written, the id is data, not context -- and by having the
 * relay re-enter the context explicitly (see `OutboxRelay`) so that
 * propagation across the fan-out is a visible line of code in one file rather
 * than magic that happens to work.
 *
 * ## Why a fresh id rather than null when there is no context
 *
 * A background sweep has no inbound request. Leaving those events with a null
 * correlation id would make the column unreliable, and an unreliable column
 * stops being used. `correlationIdOrNew()` mints one instead, so a sweep's own
 * cascade is still traceable as a unit -- it simply has no request to trace
 * back to.
 */
const storage = new AsyncLocalStorage<string>();

/** A new correlation id. UUIDv7, so ids sort in creation order like every other id in V3. */
export function newCorrelationId(): string {
  return uuidv7();
}

/** The correlation id of the unit of work currently executing, if there is one. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}

/** The current correlation id, or a fresh one when running outside any context. */
export function correlationIdOrNew(): string {
  return storage.getStore() ?? newCorrelationId();
}

/**
 * Runs `fn` with `correlationId` as the ambient correlation id.
 *
 * Nested calls replace the id for the duration of the inner call, which is
 * what makes the relay's re-entry work: dispatching an event that arrived with
 * correlation X runs its handlers -- and therefore any events they emit --
 * under X, regardless of what the sweep itself was running under.
 */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

/**
 * Accepts an inbound correlation id only if it is a plausible one.
 *
 * The id is echoed in a response header and written to nine outbox tables, so
 * an unvalidated client-supplied value is a log-injection and storage vector
 * for free. A UUID is the only shape this system produces, so anything else is
 * replaced rather than sanitised -- a rejected id costs a client nothing but a
 * broken trace, while an accepted 4KB one costs every downstream row.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function acceptInboundCorrelationId(value: unknown): string {
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value.toLowerCase() : newCorrelationId();
}

/** The header this system reads on the way in and echoes on the way out. */
export const CORRELATION_HEADER = 'x-correlation-id';
