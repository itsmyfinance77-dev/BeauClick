/**
 * The closed audit vocabulary for the service resource requirement -- V3.3
 * Story #131 (`#127b`), ADR-049 section 7.4 and `V33-DEC-035` R5.
 *
 * ## Why the action and reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only. No owner-supplied string
 * reaches this table, and no command DTO carries a `reason` field -- the same
 * reasoning `location-resource.audit.ts` and `staff-location.audit.ts` record,
 * applied here.
 *
 * ## What never reaches a snapshot
 *
 * No service name, no professional identity, no business name. The
 * `before`/`after` snapshots carry only `requiredKind` (or `null`), which is
 * exactly the one fact this table exists to record.
 *
 * `target_id` is the requirement row's own uuid, or -- when the row was just
 * deleted and has no surviving id to attach to -- the opaque `service_id` it
 * governed. Either way it is never returned over HTTP.
 */

/** The audit `target_type` every requirement action reports against. */
export const AUDIT_TARGET_SERVICE_RESOURCE_REQUIREMENT = 'business.service_resource_requirement';

export const SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS = {
  /** No prior row; a requirement was configured. `before` is `{ requiredKind: null }`. */
  set: 'business.service_resource_requirement_set',
  /** A prior row's kind was changed to a different one. */
  changed: 'business.service_resource_requirement_changed',
  /** A prior row was removed. `after` is `{ requiredKind: null }`. */
  cleared: 'business.service_resource_requirement_cleared',
} as const;

export type ServiceResourceRequirementAuditAction =
  (typeof SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS)[keyof typeof SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS];

export const SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS = {
  setByOwner: 'service resource requirement set by the business owner',
  changedByOwner: 'service resource requirement changed by the business owner',
  clearedByOwner: 'service resource requirement cleared by the business owner',
} as const;
