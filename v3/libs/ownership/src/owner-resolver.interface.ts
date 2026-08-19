/**
 * The GAP-08 fix (V3_GAP_REGISTER.md, V3_SECURITY_MODEL.md §3): V2's shared
 * ownership helper only accepted a raw owner ID and went unused because most
 * real ownership is indirect (booking -> provider -> user). An OwnerResolver
 * is an injectable class instead of a raw ID or a bare closure specifically
 * so it can depend on a repository/service to walk that indirection, while
 * staying testable and DI-friendly.
 *
 * Contract: given the resource identifiers present on the request (route
 * params) and the session's own userId, resolve the user id that actually
 * owns the target resource. Returns null when the resource does not exist
 * OR when it exists but the caller has no ownership claim to evaluate --
 * either way the guard must respond identically (never leak which).
 */
export interface OwnerResolver<TParams extends Record<string, string> = Record<string, string>> {
  resolve(sessionUserId: string, params: TParams): Promise<string | null>;
}

export type OwnerResolverClass = new (...args: never[]) => OwnerResolver;
