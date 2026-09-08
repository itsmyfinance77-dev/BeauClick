/**
 * The closed audit vocabulary for business locations -- V3.3 Story #108 (`#44b`),
 * ADR-049 section 7.4.
 *
 * ## Why the action and reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only -- it cannot UPDATE or DELETE a
 * row it has written. An owner-supplied string reaching this table would spend
 * the append-only guarantee, so every action and reason is a server-generated
 * constant here. There is no human justification to capture either: a location is
 * created, renamed or moved through its lifecycle because an owner chose to, not
 * because they reasoned about a policy, so a free-text field would prompt
 * somebody to invent one. The same reasoning `business-classification.audit.ts`
 * records for `V33-DEC-032`, applied here.
 *
 * ## Why the boot assertion cannot be cited here
 *
 * `AuditEnforcementService` refuses to boot only when a mutation gated on a
 * PRIVILEGED capability declares no `@AuditAction`. The location routes live on a
 * `@Controller('v1')` and declare no capability at all (ADR-049 section 7.4), so
 * this surface has no structural enforcement. The audit guarantee here is proved
 * DIRECTLY, by a real-PostgreSQL test that commits exactly one row per real
 * mutation, none on a read / no-op / refusal, and rolls the location change back
 * with the audit row when the audit write fails.
 *
 * ## No name, city id or reference reaches the snapshot
 *
 * The `before`/`after` snapshots carry only the lifecycle, and the action name
 * carries the rest. A location name is owner-authored text and a `city_id` /
 * `locationRef` is exactly the kind of value ADR-049 section 7.5 keeps out of
 * internal records; `target_id` is the location's own uuid, which is an
 * organisational id and names no person.
 */

/** The audit `target_type` every location action reports against. */
export const AUDIT_TARGET_BUSINESS_LOCATION = 'business.location';

export const LOCATION_AUDIT_ACTIONS = {
  /** The live owner created a location. `after` is `{ lifecycle: 'active' }`. */
  created: 'business.location_created',
  /** The live owner renamed a location that was not closed. */
  renamed: 'business.location_renamed',
  /** `active -> suspended`. */
  suspended: 'business.location_suspended',
  /** `suspended -> active`. */
  reactivated: 'business.location_reactivated',
  /** `active | suspended -> closed`. Terminal. */
  closed: 'business.location_closed',
} as const;

export type LocationAuditAction = (typeof LOCATION_AUDIT_ACTIONS)[keyof typeof LOCATION_AUDIT_ACTIONS];

export const LOCATION_AUDIT_REASONS = {
  createdByOwner: 'business location created by its owner',
  renamedByOwner: 'business location renamed by its owner',
  suspendedByOwner: 'business location suspended by its owner',
  reactivatedByOwner: 'business location reactivated by its owner',
  closedByOwner: 'business location closed by its owner',
} as const;
