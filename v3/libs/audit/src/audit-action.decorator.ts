import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'beauclick:auditAction';
export const AUDIT_EXEMPT_KEY = 'beauclick:auditExempt';

export interface AuditActionOptions {
  /**
   * Whether the audit record commits in the SAME transaction as the mutation.
   *
   * `true` (the default) is the guarantee GAP-02-V3 exists to establish: if the
   * audit insert fails, the mutation fails with it, so an unaudited
   * administrative action cannot exist.
   *
   * `false` declares, in the source, that this particular route cannot offer
   * that guarantee -- and `because` must say why. It is NOT an escape hatch for
   * convenience. There are exactly two real reasons in this codebase and both
   * are physical:
   *
   *   1. The mutation's primary effect lands in a DIFFERENT DataSource.
   *      `financial` is a physically separate connection as an append-only role
   *      (ADR-017), so a settlement and an `admin` row have no shared
   *      transaction to commit in.
   *   2. The mutation's primary effect is in an EXTERNAL system. A search
   *      reindex writes to OpenSearch; no PostgreSQL transaction can span it.
   *
   * In both cases the route still writes its audit row, so the operator has one
   * place to look. What is disclosed here is that the row follows the action
   * rather than accompanying it -- a crash in between leaves an action with no
   * record, and pretending otherwise would be the more dangerous choice.
   */
  transactional?: boolean;
  /** Required when `transactional` is false. Prose, aimed at whoever reads this next. */
  because?: string;
}

export interface AuditActionMetadata {
  action: string;
  transactional: boolean;
  because: string | null;
}

/**
 * Declares the audit action a privileged mutation writes.
 *
 * Presence is what the boot-time assertion checks; the contents are what a
 * reader needs. A route carrying neither this nor `@AuditExempt` prevents the
 * application from starting.
 */
export const AuditAction = (action: string, options: AuditActionOptions = {}): CustomDecorator<string> => {
  const transactional = options.transactional !== false;
  if (!transactional && !options.because) {
    // Thrown at decoration time, i.e. when the module is loaded, so this cannot
    // reach a running system.
    throw new Error(`@AuditAction('${action}', { transactional: false }) requires a \`because\` reason.`);
  }
  const metadata: AuditActionMetadata = {
    action,
    transactional,
    because: options.because ?? null,
  };
  return SetMetadata(AUDIT_ACTION_KEY, metadata);
};

/**
 * Declares that a privileged mutation deliberately writes no audit record, and
 * why.
 *
 * The reason is REQUIRED and is not decoration: the whole point of the
 * enforcement is that skipping an audit becomes a visible, argued decision in
 * the source rather than an omission nobody notices. V2's version of this gap
 * was found three separate times across two plugins precisely because "forgot
 * to audit" and "chose not to audit" looked identical.
 */
export const AuditExempt = (reason: string): CustomDecorator<string> => SetMetadata(AUDIT_EXEMPT_KEY, reason);
