import { Logger } from '@nestjs/common';
import { currentCorrelationId } from './correlation';

/**
 * One structured line per meaningful domain operation, always carrying the
 * correlation id.
 *
 * Not a logging framework and deliberately not an abstraction over Nest's
 * `Logger` -- it writes through it. The only thing this adds is that the
 * correlation id and the field shape are not left to each call site, because
 * a log format maintained by convention is one that diverges by the third
 * author and stops being greppable.
 *
 * Emitted as `key=value` pairs rather than JSON because these lines are read
 * in a terminal during development far more often than they are shipped to an
 * aggregator, and a JSON blob per line makes that unreadable. Both are
 * greppable; only one is legible.
 *
 * ## What must never appear here
 *
 * The same rule the event catalog enforces on payloads applies to logs, for
 * the same reason: OTP codes, passwords, tokens, payment secrets, and
 * customer free text (a journey note, a goal title, a search query) are not
 * operational data. `assertPayloadHasNoSecrets` guards the event path; this
 * one is guarded by keeping the shape to identifiers, enums, counts, and
 * durations -- values whose type cannot hold prose.
 */
export type OperationField = string | number | boolean | null | undefined;

export function logOperation(
  logger: Logger,
  operation: string,
  fields: Record<string, OperationField> = {},
): void {
  logger.log(formatOperation(operation, fields));
}

export function warnOperation(
  logger: Logger,
  operation: string,
  fields: Record<string, OperationField> = {},
): void {
  logger.warn(formatOperation(operation, fields));
}

function formatOperation(operation: string, fields: Record<string, OperationField>): string {
  const parts = [`op=${operation}`];

  const correlationId = currentCorrelationId();
  if (correlationId) parts.push(`correlation=${correlationId}`);

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === 'string' ? sanitize(value) : String(value)}`);
  }

  return parts.join(' ');
}

/**
 * Keeps a value on one line and bounded.
 *
 * A newline in a log line is how one record becomes two, which is how a
 * forged record gets into an aggregator. Nothing passed here is expected to
 * contain one -- these are ids and enum values -- so this is the backstop for
 * the case where a future field turns out to be less structured than assumed.
 */
function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 200);
}
