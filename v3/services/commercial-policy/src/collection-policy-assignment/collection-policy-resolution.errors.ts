/**
 * Why an ENROLLED party's policy could not be resolved — V3.3 Story #115
 * (`#41d-2b`), ADR-048 §7.
 *
 * A closed, bounded, low-cardinality vocabulary. Every member is a bare
 * lowercase enum value: no identity, no policy key, no version, no workspace
 * reference, no money and no caller prose. That is what makes it safe to put in
 * a metric label, and the `/^[a-z_]+$/` shape is asserted rather than merely
 * intended.
 *
 * It exists for metrics and diagnosis and **never reaches a response body**.
 * Order creation converts every one of these into the single public refusal, so
 * a client cannot tell an unavailable key from a retired version from a
 * concurrent invalidation — and cannot use the difference to enumerate which
 * sellers are enrolled or what the catalogue holds.
 */
export const COLLECTION_POLICY_RESOLUTION_CAUSES = [
  /** The assigned key has no version published and active at the database instant. */
  'no_active_version',
  /** More than one active version for one key. Unreachable while `ex_bcpv_no_effective_overlap` holds. */
  'ambiguous_version',
  /** The resolved row does not satisfy the shipped snapshot contract. */
  'invalid_snapshot',
] as const;

export type CollectionPolicyResolutionCause = (typeof COLLECTION_POLICY_RESOLUTION_CAUSES)[number];

/**
 * Thrown when an enrolled party's policy cannot be resolved.
 *
 * A plain `Error`, deliberately not a `DomainException`: this must never be
 * rendered to a client. `OrderService` catches it, records the bounded cause on
 * a metric, and raises the one public refusal instead. Making it an
 * `HttpException` subclass would route it through the filter branch that
 * returns a `code`-bearing body verbatim, and the cause would start reaching
 * browsers.
 *
 * The cause is a constructor parameter rather than free text so that no caller
 * can attach an identity or an amount to it later.
 */
export class CollectionPolicyUnresolvableError extends Error {
  constructor(readonly cause: CollectionPolicyResolutionCause) {
    super(`Enrolled seller's collection policy is unresolvable: ${cause}`);
    this.name = 'CollectionPolicyUnresolvableError';
  }
}
