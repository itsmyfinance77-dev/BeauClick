/**
 * The closed audit vocabulary for business classification (ADR-049 section 7.4).
 *
 * ## Why the action and the reason are constants, never parameters
 *
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only -- it cannot UPDATE or DELETE a
 * row it has written, and cannot grant itself the right to. An append-only log
 * is worth exactly as much as the guarantee that nobody can write arbitrary
 * content into it, so an owner-supplied string reaching this table would spend
 * that guarantee. The same reasoning `seller-subscription.audit.ts` records for
 * `V33-DEC-018`, applied here.
 *
 * Nothing in this surface is a human justification, either. A classification
 * replacement happens because an owner chose what their business is; there is no
 * decision for them to explain, so a free-text field would be prompting somebody
 * to invent a reason for something they did not reason about.
 *
 * ## Why the boot assertion cannot be cited here
 *
 * `AuditEnforcementService` refuses to boot only when a mutation gated on a
 * PRIVILEGED capability declares no `@AuditAction`. `BusinessController` is
 * `@Controller('v1')` and declares no capability at all, so this surface has no
 * structural enforcement whatsoever (ADR-049 section 7.4). The audit guarantee
 * here is proved DIRECTLY, by a real-PostgreSQL test that commits one row on
 * success and rolls the classification back with the audit row when the audit
 * write fails.
 *
 * Adding an action means adding a constant here, which is the point: the set is
 * greppable and finite.
 */

/** The audit `target_type` every classification action reports against. */
export const AUDIT_TARGET_BUSINESS_CLASSIFICATION = 'business.classification';

export const CLASSIFICATION_AUDIT_ACTIONS = {
  /**
   * A business owner replaced the whole classification -- the vertical and the
   * trait set together.
   *
   * The name says REPLACED, not "set" or "updated": the command is a full
   * replacement of one current state by another, and an audit action implying a
   * partial edit would be the first place a reader learned the wrong thing.
   */
  replaced: 'business.classification_replaced',
} as const;

export const CLASSIFICATION_AUDIT_REASONS = {
  /** The only path that writes: the live owner submitted a complete classification. */
  replacedByOwner: 'business classification replaced by its owner',
} as const;
