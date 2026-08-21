/**
 * Resolves the session user to the party analytics is allowed to report on.
 *
 * A port rather than a direct call into provider-service, for two reasons.
 * The lint-enforced one: analytics may not depend on another domain
 * (ADR-011). The design one: the ONLY way a caller can name a subject is by
 * being that subject, and routing that resolution through an interface the
 * composition root implements means analytics-service literally cannot look
 * up an arbitrary professional even if a future author wanted it to.
 */
export interface AnalyticsSubjectResolverPort {
  /** The professional profile owned by this user, or null if they have none. */
  professionalIdForUser(userId: string): Promise<string | null>;
}

export const ANALYTICS_SUBJECT_RESOLVER = Symbol('BEAUCLICK_ANALYTICS_SUBJECT_RESOLVER');
