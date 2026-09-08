/**
 * The closed audit vocabulary for scoped staff authority and staff invitation --
 * V3.3 Story #109 (`#44c`), ADR-049 section 7.4 and `V33-DEC-033` R5.
 *
 * ## Why the action and reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only -- it cannot UPDATE or DELETE a
 * row it has written. An append-only log is worth exactly as much as the
 * guarantee that nobody can write arbitrary content into it, so no
 * owner-supplied string reaches this table. The same reasoning
 * `business-classification.audit.ts` and `business-location.audit.ts` record,
 * applied here.
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
 * No phone number, no phone derivative, no invitee identity, no professional id
 * and no opaque reference. `target_id` is a `business` row id -- a membership id
 * or a grant id -- which names an organisation fact, and the acting owner is the
 * `actor_user_id` column where actor identity legitimately lives.
 *
 * ## Nothing is written on a negative invitation path
 *
 * `V33-DEC-033` R3. An unknown, ineligible, duplicate, foreign or self
 * invitation writes **no** audit row: a per-attempt record would be exactly the
 * "someone tried to invite this phone number" trace ADR-049 section 4.6 forbids,
 * and an operator-queryable one at that.
 */

/** The audit `target_type` for a scoped grant. */
export const AUDIT_TARGET_STAFF_ROLE_GRANT = 'business.staff_grant';

/** The audit `target_type` for a staff membership. */
export const AUDIT_TARGET_STAFF_MEMBERSHIP = 'business.staff_membership';

export const STAFF_AUTHORITY_AUDIT_ACTIONS = {
  /** The live owner granted a scoped role to an accepted, professional-linked membership. */
  granted: 'business.staff_grant_granted',
  /** The live owner revoked a live scoped grant. One-way; the row is never deleted. */
  revoked: 'business.staff_grant_revoked',
  /**
   * A phone invitation resolved to an eligible account and a membership was
   * created at `invited`. Written **only** on this path.
   */
  invited: 'business.staff_invited',
} as const;

export type StaffAuthorityAuditAction =
  (typeof STAFF_AUTHORITY_AUDIT_ACTIONS)[keyof typeof STAFF_AUTHORITY_AUDIT_ACTIONS];

export const STAFF_AUTHORITY_AUDIT_REASONS = {
  grantedByOwner: 'scoped staff role granted by the business owner',
  revokedByOwner: 'scoped staff role revoked by the business owner',
  invitedByOwner: 'business staff invitation created by the business owner',
} as const;
