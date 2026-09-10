/**
 * The closed audit vocabulary for the staff delivery-location binding --
 * V3.3 Story #127 (`#127a`), ADR-049 §7.4 and `V33-DEC-035` R2.
 *
 * ## Why the action and reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only -- it cannot UPDATE or DELETE a
 * row it has written. An append-only log is worth exactly as much as the
 * guarantee that nobody can write arbitrary content into it, so no owner-supplied
 * string reaches this table. **No command DTO carries a `reason`**, which makes
 * that structural rather than a convention: there is no field through which
 * client free text could arrive.
 *
 * The same reasoning `business-location.audit.ts`, `staff-authority.audit.ts` and
 * `location-resource.audit.ts` record, applied here.
 *
 * ## Two actions, because the two facts are genuinely different
 *
 * Assigning a branch and clearing one are separate operational events: the first
 * says a practitioner started delivering somewhere, the second says they stopped.
 * Collapsing them into one "changed" action would make the log unable to answer
 * "when did this member stop working at that branch" without diffing snapshots.
 *
 * ## What never reaches a snapshot
 *
 * No `locationRef`, no location name, no city, no professional id and no phone.
 * The `before`/`after` snapshots carry the raw location id -- an organisational
 * id that names no person -- and `target_id` is the membership row. The acting
 * owner is `actor_user_id`, where actor identity legitimately lives.
 *
 * A `locationRef` in particular is deliberately absent: it is owner-bound and
 * session-derived, exactly the kind of value ADR-049 §7.5 keeps out of internal
 * records, and it would be meaningless to a later reader anyway.
 */

/** The audit `target_type` for a membership's delivery-location binding. */
export const AUDIT_TARGET_STAFF_LOCATION = 'business.staff_location';

export const STAFF_LOCATION_AUDIT_ACTIONS = {
  /** The live owner bound a membership to a branch. `after` carries the location id. */
  assigned: 'business.staff_location_assigned',
  /** The live owner removed a membership's branch. `after.locationId` is null. */
  cleared: 'business.staff_location_cleared',
} as const;

export type StaffLocationAuditAction =
  (typeof STAFF_LOCATION_AUDIT_ACTIONS)[keyof typeof STAFF_LOCATION_AUDIT_ACTIONS];

export const STAFF_LOCATION_AUDIT_REASONS = {
  assignedByOwner: 'staff delivery location assigned by the business owner',
  clearedByOwner: 'staff delivery location cleared by the business owner',
} as const;
