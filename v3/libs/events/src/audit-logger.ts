import { Logger } from '@nestjs/common';
import { currentCorrelationId } from './correlation';

export type AuditField = string | number | boolean | null | undefined;

export interface AuditRecord extends Record<string, AuditField> {
  action: string;
}

/**
 * The audit log, with the correlation id attached by construction.
 *
 * Phase 2 introduced the convention `new Logger('AUDIT:<domain>')` and a
 * record shape of `{ action, ...fields }`. It worked, and it had the usual
 * problem with conventions: the correlation id could only be added by every
 * author remembering to add it to every call, and an audit trail that has the
 * id on most lines is not one you can follow.
 *
 * This is a drop-in for that `Logger`. The 30 existing call sites keep their
 * shape; changing the declaration is what gives all of them the id.
 *
 * ## Why it lives in `@beauclick/events`
 *
 * Because the correlation id does, and because that is already the one library
 * every domain depends on -- it owns the outbox base entity. A separate
 * `observability` library would be the tidier boundary and would also be a new
 * Nx project, path mapping, and lint tag for two small files. If observability
 * grows beyond this, that is the moment to split it out.
 *
 * ## What must never be passed
 *
 * Audit records are identifiers, enums, and counts. Not OTP codes, tokens,
 * payment secrets, or customer free text -- the same deny-list the event
 * catalog enforces on payloads, for the same reason: a log aggregator is a
 * second, less-guarded copy of whatever you put in it. The `AuditField` type
 * cannot express an object, which at least stops an entity being spread in
 * wholesale.
 */
export class AuditLogger {
  private readonly logger: Logger;

  constructor(domain: string) {
    this.logger = new Logger(`AUDIT:${domain}`);
  }

  log(record: AuditRecord): void {
    this.logger.log(this.decorate(record));
  }

  warn(record: AuditRecord): void {
    this.logger.warn(this.decorate(record));
  }

  error(record: AuditRecord): void {
    this.logger.error(this.decorate(record));
  }

  private decorate(record: AuditRecord): Record<string, AuditField> {
    const correlationId = currentCorrelationId();
    // The id first, so it is the first thing on the line when the record is
    // read by a person rather than a query.
    return correlationId ? { correlation: correlationId, ...record } : { ...record };
  }
}
