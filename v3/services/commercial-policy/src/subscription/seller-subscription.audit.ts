/**
 * The closed audit vocabulary for subscription actions (ADR-042 §10).
 *
 * ## Why the reasons are constants and not parameters
 *
 * `V33-DEC-018`: audit reasons are closed, server-generated values, and no DTO
 * or internal API accepts free-text audit prose.
 *
 * That is a security property, not a tidiness preference. `admin.admin_audit_log`
 * is owned by `beauclick_admin_audit_owner` and the application holds INSERT and
 * SELECT only — it cannot UPDATE or DELETE a row it has written, and cannot
 * grant itself the right to. An append-only log is worth having exactly to the
 * extent that nobody can write arbitrary content into it, so a seller-supplied
 * string reaching this table would spend the guarantee the role separation
 * buys.
 *
 * The catalogue's administrator surface (#40a) is the deliberate contrast: it
 * REQUIRES a typed reason, because a privileged human decided something and
 * their justification is the record. Nothing here is a human decision — every
 * action below happens because a seller party exists, or because a lifecycle
 * transition was requested — so a free-text field would be prompting somebody
 * to invent a reason for an action they did not reason about.
 *
 * Adding an action means adding a constant here, which is the point: the set is
 * greppable and finite.
 */

/** The audit `target_type` every subscription action reports against. */
export const AUDIT_TARGET_SUBSCRIPTION = 'commercial.seller_subscription';

/**
 * The actor label for automatic assignment and grant issuance.
 *
 * `admin.admin_audit_log.actor_label` exists for exactly this — "a short label
 * for a non-session actor" — and `ck_admin_audit_actor` enforces that it is
 * present precisely when `actor_user_id` is NULL. So an automatic action is
 * structurally distinguishable from a human one, and `V33-DEC-018`'s "do not
 * fabricate a human actor" is a database property rather than a convention.
 */
export const SYSTEM_ACTOR_LABEL = 'system';

/**
 * The label the migration backfill acts under.
 *
 * The same value `#40a`'s `D-7` seed used, so "what did the V3.3-A migrations
 * do" is one query rather than a list of labels somebody has to remember.
 * Defined here for the tests that assert it; the backfill itself is SQL and
 * spells it inline, because a migration cannot import TypeScript.
 */
export const MIGRATION_ACTOR_LABEL = 'migration:v3.3-a';

export const SUBSCRIPTION_AUDIT_ACTIONS = {
  assigned: 'commercial.subscription_assigned',
  activated: 'commercial.subscription_activated',
  superseded: 'commercial.subscription_superseded',
  cancelled: 'commercial.subscription_cancelled',
  creditsGranted: 'commercial.credits_granted',
} as const;

export const SUBSCRIPTION_AUDIT_REASONS = {
  /** The lazy-ensure path: this party had no active subscription and now has the base workspace. */
  baseWorkspaceAssigned: 'base workspace assigned automatically on first commercial access',
  /** A seller selected a different published version (#69 drives this; the service already supports it). */
  planVersionSelected: 'seller selected a published plan version',
  /** The previous active subscription was replaced by a newer one in the same transaction. */
  supersededBySelection: 'superseded by a newer subscription for the same party',
  /** A seller cancelled; the base workspace is restored in the same transaction. */
  cancelledBySeller: 'subscription cancelled by the seller',
  /** The base workspace restored after a cancellation, so the party is never entitled to nothing. */
  baseWorkspaceRestored: 'base workspace restored after cancellation',
  /** Credits conferred by an activation, read from the subscription snapshot. */
  creditsGranted: 'plan-included booking credits granted from the subscription snapshot',
} as const;

export type SubscriptionAuditReason =
  (typeof SUBSCRIPTION_AUDIT_REASONS)[keyof typeof SUBSCRIPTION_AUDIT_REASONS];
