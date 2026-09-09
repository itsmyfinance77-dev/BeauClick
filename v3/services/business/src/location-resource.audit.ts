/**
 * The closed audit vocabulary for the location resource catalogue -- V3.3 Story
 * #110 (`#110a`), ADR-049 section 7.4 and `V33-DEC-034` R3.
 *
 * ## Why the action and reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only -- it cannot UPDATE or DELETE a
 * row it has written. An append-only log is worth exactly as much as the
 * guarantee that nobody can write arbitrary content into it, so no owner-supplied
 * string reaches this table. There is no human justification to capture either: a
 * resource is created, renamed or retired because an owner chose to, not because
 * they reasoned about a policy, so a free-text field would only prompt somebody
 * to invent one. The same reasoning `business-location.audit.ts` and
 * `staff-authority.audit.ts` record, applied here.
 *
 * **No command DTO carries a `reason`**, so this is structural rather than a
 * convention: there is no field through which client free text could arrive.
 *
 * ## Why the boot assertion cannot be cited here
 *
 * `AuditEnforcementService` refuses to boot only when a mutation gated on a
 * PRIVILEGED capability declares no `@AuditAction`. These routes live on a
 * `@Controller('v1')` and declare no capability at all (ADR-049 section 7.4), so
 * this surface has no structural enforcement. The guarantee is proved DIRECTLY,
 * by a real-PostgreSQL test that commits exactly one row per real mutation, none
 * on a read, no-op or refusal, and rolls the mutation back with the audit row
 * when the audit write fails.
 *
 * ## What never reaches a snapshot
 *
 * No `resourceRef`, no `locationRef`, no resource or location name, no kind, no
 * secret, no phone, no customer and no booking data. The `before`/`after`
 * snapshots carry only the lifecycle, and the action name carries the rest --
 * exactly as #108 does. A resource name is owner-authored text and a reference is
 * precisely the kind of value ADR-049 section 7.5 keeps out of internal records.
 *
 * `target_id` is the resource's own uuid: an organisational id that names no
 * person, and the id internal traceability actually needs. It is never returned
 * over HTTP -- the API exposes only the derived `resourceRef` -- so recording it
 * here leaks nothing a reader of the audit log did not already have.
 */

/** The audit `target_type` every resource action reports against. */
export const AUDIT_TARGET_LOCATION_RESOURCE = 'business.location_resource';

export const LOCATION_RESOURCE_AUDIT_ACTIONS = {
  /** The live owner created a resource. `after` is `{ lifecycle: 'active' }`. */
  created: 'business.location_resource_created',
  /** The live owner renamed an active resource. A retired one cannot be renamed. */
  renamed: 'business.location_resource_renamed',
  /** `active -> retired`. Terminal; there is no counterpart action because there is no restore. */
  retired: 'business.location_resource_retired',
} as const;

export type LocationResourceAuditAction =
  (typeof LOCATION_RESOURCE_AUDIT_ACTIONS)[keyof typeof LOCATION_RESOURCE_AUDIT_ACTIONS];

export const LOCATION_RESOURCE_AUDIT_REASONS = {
  createdByOwner: 'location resource created by the business owner',
  renamedByOwner: 'location resource renamed by the business owner',
  retiredByOwner: 'location resource retired by the business owner',
} as const;
