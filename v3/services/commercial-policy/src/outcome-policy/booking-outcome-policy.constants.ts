import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';

import {
  CommercialActivationOverlapException,
  CommercialKeyExistsException,
  CommercialLifecycleConflictException,
} from '../catalogue/commercial-catalogue.exceptions';

/**
 * The closed audit-action vocabulary of `#42a` — ADR-051 §5 and §10.
 *
 * Every privileged mutation on the outcome-policy surface writes exactly one
 * of these in the SAME transaction as the domain change. Reads write nothing.
 * A member is spelled here once and imported by both the controller
 * (`@AuditAction`) and the service (`AdminAuditService.record`), so the two
 * cannot drift apart.
 */
export const OUTCOME_POLICY_AUDIT_ACTIONS = {
  policyCreated: 'commercial.outcome_policy_created',
  versionDrafted: 'commercial.outcome_policy_version_drafted',
  versionUpdated: 'commercial.outcome_policy_version_updated',
  versionPublished: 'commercial.outcome_policy_version_published',
  versionRetired: 'commercial.outcome_policy_version_retired',
  versionDiscarded: 'commercial.outcome_policy_version_discarded',
  copyCreated: 'commercial.customer_policy_copy_created',
  copyVersionDrafted: 'commercial.customer_policy_copy_version_drafted',
  copyVersionUpdated: 'commercial.customer_policy_copy_version_updated',
  copyVersionPublished: 'commercial.customer_policy_copy_version_published',
  copyVersionRetired: 'commercial.customer_policy_copy_version_retired',
  copyVersionDiscarded: 'commercial.customer_policy_copy_version_discarded',
  legalEvidenceRecorded: 'commercial.legal_evidence_recorded',
  legalEvidenceRetired: 'commercial.legal_evidence_retired',
} as const;

/*
 * `admin.admin_audit_log.target_type` is VARCHAR(40); every member below is
 * shorter than that, and a fast test pins it so a rename cannot make the audit
 * row of a real publication the first thing to fail.
 */
export const OUTCOME_POLICY_AUDIT_TARGETS = {
  policy: 'commercial_outcome_policy',
  policyVersion: 'commercial_outcome_policy_version',
  copy: 'commercial_customer_policy_copy',
  copyVersion: 'commercial_customer_copy_version',
  legalEvidence: 'commercial_legal_evidence',
} as const;

/** PostgreSQL SQLSTATEs the services tell apart by NAME rather than by catching everything. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_RESTRICT_VIOLATION = '23001';

/** How many times a draft creation re-derives its version number after losing a race. */
export const VERSION_ALLOCATION_ATTEMPTS = 3;

/**
 * A `legalCap` was sent, and it cannot be accepted.
 *
 * ONE code for every cause — no reference, an unknown key, a retired record,
 * a record about something else. An administrator holding
 * `bc_manage_commercial_plans` can list evidence records and see which is
 * which; the refusal itself must not become the lookup. Raised inside the
 * transaction, so nothing is written (ADR-051 §5).
 */
export class CommercialLegalEvidenceNotQualifyingException extends DomainException {
  constructor() {
    super(
      'COMMERCIAL_LEGAL_EVIDENCE_NOT_QUALIFYING',
      'سقف قانونی بدون مدرک حقوقی معتبر قابل ثبت نیست.',
      HttpStatus.CONFLICT,
    );
  }
}

export function pgCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const direct = candidate?.code;
  if (typeof direct === 'string') return direct;
  const driver = candidate?.driverError?.code;
  return typeof driver === 'string' ? driver : undefined;
}

/**
 * Turns the database's own refusal into a typed one.
 *
 * The DB message is deliberately NOT echoed: a trigger's text names tables,
 * columns and constraints. Only three SQLSTATEs are translated; an unknown code
 * is re-thrown unchanged, because a `check_violation` from a shape the service
 * was supposed to have validated is a defect, not an expected conflict.
 */
export function rethrowTranslated(error: unknown, subject: string): never {
  const code = pgCode(error);
  if (code === PG_EXCLUSION_VIOLATION) throw new CommercialActivationOverlapException();
  if (code === PG_UNIQUE_VIOLATION) throw new CommercialKeyExistsException();
  if (code === PG_RESTRICT_VIOLATION) {
    throw new CommercialLifecycleConflictException(`the database refused this change to the ${subject}`);
  }
  throw error;
}

export async function translating<T>(operation: () => Promise<T>, subject: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowTranslated(error, subject);
  }
}
