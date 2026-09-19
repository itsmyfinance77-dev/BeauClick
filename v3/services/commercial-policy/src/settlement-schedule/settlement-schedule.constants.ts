import {
  CommercialActivationOverlapException,
  CommercialKeyExistsException,
  CommercialLifecycleConflictException,
} from '../catalogue/commercial-catalogue.exceptions';

/**
 * The closed audit-action vocabulary of `#43d` — ADR-052 §1 and §8's
 * "same-transaction admin audit row".
 *
 * Every privileged mutation on the settlement surface writes exactly one of
 * these in the SAME transaction as the domain change; reads write nothing. A
 * member is spelled here once and imported by both the controller
 * (`@AuditAction`) and the services, so the two cannot drift apart.
 */
export const SETTLEMENT_AUDIT_ACTIONS = {
  policyCreated: 'commercial.settlement_schedule_created',
  versionDrafted: 'commercial.settlement_version_drafted',
  versionUpdated: 'commercial.settlement_version_updated',
  versionPublished: 'commercial.settlement_version_published',
  versionRetired: 'commercial.settlement_version_retired',
  versionDiscarded: 'commercial.settlement_version_discarded',
  riskClassAssigned: 'commercial.seller_risk_class_assigned',
} as const;

/*
 * `admin.admin_audit_log.target_type` is VARCHAR(40); every member below is
 * shorter, and the fast spec pins their length so a rename cannot make the
 * audit row of a real publication the first thing to fail.
 */
export const SETTLEMENT_AUDIT_TARGETS = {
  policy: 'commercial_settlement_schedule',
  policyVersion: 'commercial_settlement_version',
  riskClass: 'commercial_seller_risk_class',
} as const;

/*
 * The SQLSTATEs and the translation helper below are COPIED rather than
 * imported, the same choice `#43b-1`'s plane makes and for the same reason:
 * each publication plane keeps its own refusal shape, so a boundary pin on
 * one cannot be weakened by another importing from it.
 */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_RESTRICT_VIOLATION = '23001';

/** How many times a draft creation re-derives its version number after losing a race. */
export const SETTLEMENT_VERSION_ALLOCATION_ATTEMPTS = 3;

export function pgCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const direct = candidate?.code;
  if (typeof direct === 'string') return direct;
  const driver = candidate?.driverError?.code;
  return typeof driver === 'string' ? driver : undefined;
}

/**
 * Turns the database's own refusal into a typed one. The DB message is
 * deliberately NOT echoed: a trigger's text names tables, columns and
 * constraints. An unknown code is re-thrown unchanged, because a
 * `check_violation` from a shape the service was supposed to have validated
 * is a defect, not an expected conflict.
 */
export function rethrowSettlementRefusal(error: unknown, subject: string): never {
  const code = pgCode(error);
  if (code === PG_EXCLUSION_VIOLATION) throw new CommercialActivationOverlapException();
  if (code === PG_UNIQUE_VIOLATION) throw new CommercialKeyExistsException();
  if (code === PG_RESTRICT_VIOLATION) {
    throw new CommercialLifecycleConflictException(`the database refused this change to the ${subject}`);
  }
  throw error;
}

export async function translatingSettlement<T>(operation: () => Promise<T>, subject: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowSettlementRefusal(error, subject);
  }
}
