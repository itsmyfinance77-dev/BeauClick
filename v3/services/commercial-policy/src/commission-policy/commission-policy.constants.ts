import {
  CommercialActivationOverlapException,
  CommercialKeyExistsException,
  CommercialLifecycleConflictException,
} from '../catalogue/commercial-catalogue.exceptions';

/**
 * The closed audit-action vocabulary of `#43b-1` — ADR-052 §1's "same-transaction
 * admin audit row".
 *
 * Every privileged mutation on the commission surface writes exactly one of
 * these in the SAME transaction as the domain change; reads write nothing. A
 * member is spelled here once and imported by both the controller
 * (`@AuditAction`) and the service (`AdminAuditService.record`), so the two
 * cannot drift apart.
 */
export const COMMISSION_AUDIT_ACTIONS = {
  policyCreated: 'commercial.commission_policy_created',
  versionDrafted: 'commercial.commission_version_drafted',
  versionUpdated: 'commercial.commission_version_updated',
  versionPublished: 'commercial.commission_version_published',
  versionRetired: 'commercial.commission_version_retired',
  versionDiscarded: 'commercial.commission_version_discarded',
} as const;

/*
 * `admin.admin_audit_log.target_type` is VARCHAR(40); both members below are
 * shorter, and the fast spec pins their length so a rename cannot make the
 * audit row of a real publication the first thing to fail.
 */
export const COMMISSION_AUDIT_TARGETS = {
  policy: 'commercial_commission_policy',
  policyVersion: 'commercial_commission_version',
} as const;

/*
 * The SQLSTATEs and the translation helper below are COPIED from
 * `outcome-policy/booking-outcome-policy.constants.ts` rather than imported —
 * the same choice `no-hardcoded-commission-rate.spec.ts` makes about
 * `stripTypeScriptNoise`, and for the same reason. `#42a`'s boundary spec pins
 * the exact set of files that reach into its folder, and a story importing a
 * four-line helper from another story's plane would either weaken that pin or
 * make `#43b-1` a permanent entry in it. Both planes are publication surfaces
 * that will outlive each other's refactors; neither should be able to change
 * the other's refusal shape by accident.
 */

/** PostgreSQL SQLSTATEs this surface tells apart by NAME rather than catching everything. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_RESTRICT_VIOLATION = '23001';

/** How many times a draft creation re-derives its version number after losing a race. */
export const COMMISSION_VERSION_ALLOCATION_ATTEMPTS = 3;

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
 * columns and constraints. Only three SQLSTATEs are translated; an unknown
 * code is re-thrown unchanged, because a `check_violation` from a shape the
 * service was supposed to have validated is a defect, not an expected
 * conflict.
 */
export function rethrowCommissionRefusal(error: unknown, subject: string): never {
  const code = pgCode(error);
  if (code === PG_EXCLUSION_VIOLATION) throw new CommercialActivationOverlapException();
  if (code === PG_UNIQUE_VIOLATION) throw new CommercialKeyExistsException();
  if (code === PG_RESTRICT_VIOLATION) {
    throw new CommercialLifecycleConflictException(`the database refused this change to the ${subject}`);
  }
  throw error;
}

export async function translatingCommission<T>(operation: () => Promise<T>, subject: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowCommissionRefusal(error, subject);
  }
}
