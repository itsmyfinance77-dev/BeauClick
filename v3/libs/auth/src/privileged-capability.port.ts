/**
 * Re-verifies a PRIVILEGED capability against live data.
 *
 * THE PROBLEM THIS SOLVES. Capabilities are baked into the access token at
 * issue time, so revoking a role normally takes effect only when the next
 * token is issued -- up to the access token's TTL (15 minutes by default).
 * For ordinary capabilities that window is unremarkable: the worst case is a
 * customer keeping `bc_book_service` slightly too long.
 *
 * For `bc_manage_platform` it is not unremarkable. An operator whose authority
 * has just been revoked -- because they left, or because the revocation is the
 * response to something they did -- should not keep settling money and
 * reindexing search for another fifteen minutes.
 *
 * THE SHAPE. A port, implemented by the composition root against
 * identity-service, because `libs/auth` may not import a `services/*` package
 * (ADR-011, enforced by lint). The same indirection `PROFESSIONAL_DIRECTORY`
 * uses.
 *
 * THE COST, stated so the trade-off is visible: one indexed lookup per request
 * to a privileged route. Not per request overall -- `CapabilityGuard` consults
 * this only when the required capability is privileged, which is the admin
 * surface and nothing else.
 *
 * FAIL CLOSED. If the verifier throws, the guard denies. A verifier that cannot
 * answer is not evidence that the caller is authorized.
 */
export interface PrivilegedCapabilityVerifier {
  hasCapability(userId: string, capability: string): Promise<boolean>;
}

export const PRIVILEGED_CAPABILITY_VERIFIER = Symbol('BEAUCLICK_PRIVILEGED_CAPABILITY_VERIFIER');

/**
 * The capabilities that get the live re-check.
 *
 * Deliberately the same list `libs/audit`'s boot assertion treats as
 * privileged. They are the same concept -- "authority over other people's data
 * or the platform" -- and two lists that must agree are one list waiting to
 * disagree, so `libs/audit` imports this one.
 */
export const PRIVILEGED_CAPABILITIES: readonly string[] = [
  'bc_manage_platform',
  'bc_moderate_verification',
  'bc_moderate_reviews',
  // V3.1 Phase C. Authority to remove another professional's published work
  // from the marketplace, so it carries both properties this list confers:
  // the live revocation re-check, and `libs/audit`'s refusal to boot when a
  // mutation gated on it declares no audit record.
  'bc_moderate_media',
  // V3.2-B. Authority to read a private conversation between two other people,
  // so it carries both properties this list confers: the live revocation
  // re-check, and `libs/audit`'s refusal to boot when a mutation gated on it
  // declares no audit record. Reading -- not only deciding -- is the privilege
  // that matters here, and the moderation controller audits both.
  'bc_moderate_chat',
  // V3.3-A Story #40 (`#40a`). Authority to publish the commercial terms
  // sellers are billed against -- immutable plan versions, their entitlements,
  // their activation windows, and the price schedules behind them. A published
  // version can never be edited or reactivated, so it carries both properties
  // this list confers: the live revocation re-check, so a withdrawn
  // administrator cannot publish a permanent commitment for another fifteen
  // minutes; and `libs/audit`'s refusal to boot when a mutation gated on it
  // declares no audit record.
  'bc_manage_commercial_plans',
];
