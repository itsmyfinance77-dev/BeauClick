/**
 * The closed audit vocabulary for automatic seller-owner role grants
 * (`V33-DEC-021` Rulings 2, 3 and 7).
 *
 * ## Why the reasons are constants and not parameters
 *
 * The same rule `seller-subscription.audit.ts` records for #56a, for the same
 * reason: `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and
 * the application holds INSERT and SELECT only. It cannot UPDATE or DELETE a
 * row it has written and cannot grant itself the right to. An append-only log
 * is worth having exactly to the extent that nobody can write arbitrary content
 * into it, so a caller-supplied string reaching this table would spend the
 * guarantee the role separation buys.
 *
 * Nothing here is a human decision. A seller created a workspace, or a
 * migration found one that already existed; neither is an act anyone reasoned
 * about, so a free-text field would be prompting somebody to invent a
 * justification for something automatic.
 *
 * ## Four distinguishable facts, not one
 *
 * `V33-DEC-021` requires the audit trail to separate the professional grant
 * from the business grant, and the live trigger from the migration backfill.
 * Two actions and two actor labels give four distinct combinations, so "which
 * of the four happened" is answerable by a query rather than by inference.
 */

/** The audit `target_type` every automatic role grant reports against. */
export const AUDIT_TARGET_USER_ROLE = 'identity.user_role';

/**
 * The actor label for a grant that happened because a seller created a
 * workspace.
 *
 * `ck_admin_audit_actor` enforces that `actor_label` is present precisely when
 * `actor_user_id` is NULL, so an automatic action is structurally
 * distinguishable from a human one. The seller is the TARGET of the grant, not
 * its actor: they asked for a professional profile, not for a role, and naming
 * them as the granting actor would misdescribe what happened.
 */
export const OWNER_ROLE_SYSTEM_ACTOR_LABEL = 'system';

/**
 * The label the #75 backfill acts under.
 *
 * Distinct from `migration:v3.3-a` on purpose. That label belongs to #56a's
 * `D-7` assignment, and reusing it would merge two different migrations'
 * evidence into one bucket — the opposite of what `V33-DEC-021` Ruling 7 asks
 * for. Defined here for the tests that assert it; the backfill itself is SQL
 * and spells it inline, because a migration cannot import TypeScript.
 */
export const OWNER_ROLE_MIGRATION_ACTOR_LABEL = 'migration:v3.3-#75';

export const OWNER_ROLE_AUDIT_ACTIONS = {
  professionalGranted: 'identity.professional_owner_role_granted',
  businessGranted: 'identity.business_owner_role_granted',
} as const;

export const OWNER_ROLE_AUDIT_REASONS = {
  /** The live trigger: this user created and owns a professional profile. */
  professionalOwnershipCreated: 'professional role granted automatically on professional ownership creation',
  /** The live trigger: this user created and owns a business. */
  businessOwnershipCreated: 'business role granted automatically on business ownership creation',
  /** The backfill: the professional row predates the grant path. */
  professionalBackfill: 'professional role granted by migration backfill from existing ownership',
  /** The backfill: the business row predates the grant path. */
  businessBackfill: 'business role granted by migration backfill from existing ownership',
} as const;

export type OwnerRoleAuditReason =
  (typeof OWNER_ROLE_AUDIT_REASONS)[keyof typeof OWNER_ROLE_AUDIT_REASONS];

/**
 * The two role slugs an ownership trigger may grant, and the only two.
 *
 * A union type rather than `string`, so a caller cannot reach this path with
 * `administrator` even by mistake — and so adding a third would be a
 * deliberate edit here rather than a new string somewhere else.
 */
export const OWNER_ROLE_SLUGS = ['professional', 'business'] as const;
export type OwnerRoleSlug = (typeof OWNER_ROLE_SLUGS)[number];
