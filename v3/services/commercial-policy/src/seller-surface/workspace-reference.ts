import { Inject, Injectable } from '@nestjs/common';

import {
  WORKSPACE_REFERENCE_SECRET,
  WorkspaceParty,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
  workspaceReferencesMatch,
} from '@beauclick/workspace-reference';

import { OwnedSubscriberParty } from '../subscription/owned-subscriber-party.port';
import { SubscriptionSellerNotEligibleException } from '../subscription/seller-subscription.exceptions';

/**
 * The subscription surface's view of the workspace reference — Story #69
 * (`V33-DEC-019`), re-pointed at the shared primitive by `V33-DEC-020`.
 *
 * ## What moved, and what deliberately did not
 *
 * The cryptography moved to `@beauclick/workspace-reference` so bug #72 could
 * reuse it from `services/financial` without importing this domain —
 * `@nx/enforce-module-boundaries` restricts `scope:financial` to
 * `scope:shared`, and duplicating a MAC construction is forbidden.
 *
 * **Nothing observable changed.** The prefix, the length-prefixed encoding, the
 * key and the digest are the same, so every reference this surface has ever
 * issued still resolves; the shared library pins that with golden vectors.
 *
 * What stayed here is the only part that was ever subscription-specific: the
 * REFUSAL. A shared library must not decide what a failed match means to a
 * caller, because two domains' security vocabularies would then be one.
 *
 * ## Still not an authorization token
 *
 * Every request re-enumerates the caller's currently owned parties, recomputes
 * their references and matches. Nothing is looked up FROM a reference, so a
 * reference stolen from another seller is inert and a party sold or deleted
 * between two calls stops resolving without anything having expired.
 */

// Re-exported so this module's consumers, and #69's own suite, keep one import
// site. The values are the shared library's — there is no second definition.
export {
  DEVELOPMENT_WORKSPACE_REFERENCE_SECRET,
  WORKSPACE_PARTY_TYPES,
  WORKSPACE_REFERENCE_DOMAIN,
  WORKSPACE_REFERENCE_LENGTH,
  WORKSPACE_REFERENCE_PATTERN,
  WORKSPACE_REFERENCE_SECRET,
  WorkspaceReferenceError,
  assertSellerWorkspaceParty,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
  workspaceReferenceInput,
  workspaceReferencesMatch,
} from '@beauclick/workspace-reference';
export type { WorkspaceParty } from '@beauclick/workspace-reference';

/**
 * Derives references, and resolves one back to a party the caller OWNS.
 *
 * The resolution order is the security property, and it is the order of
 * `resolve` below rather than a comment:
 *
 *  1. the caller is already authenticated — the guard ran before the handler;
 *  2. their CURRENTLY owned parties were enumerated live, inside the request's
 *     own transaction, by #56a's ownership resolver;
 *  3. candidate references are computed server-side;
 *  4. the supplied value is validated against the closed format contract;
 *  5. it is compared against every candidate in constant time;
 *  6. only a match yields a party.
 */
@Injectable()
export class WorkspaceReferenceService {
  constructor(@Inject(WORKSPACE_REFERENCE_SECRET) private readonly secret: string) {}

  referenceFor(ownerUserId: string, party: OwnedSubscriberParty): string {
    return deriveWorkspaceReference(this.secret, ownerUserId, party as WorkspaceParty);
  }

  /**
   * The comparison seam, as a METHOD rather than the free function directly.
   *
   * A module-level call compiles to a direct local reference, which no spy can
   * observe — so a test claiming "the constant-time comparison ran" could only
   * assert that the outcome was right, which a `===` would also satisfy. A
   * prototype method is patchable, so the suite can prove this is invoked once
   * per owned party AND that replacing it changes the result.
   */
  matchesReference(candidate: string, supplied: string): boolean {
    return workspaceReferencesMatch(candidate, supplied);
  }

  /**
   * The one party this reference names, for this caller, right now.
   *
   * Throws `SubscriptionSellerNotEligibleException` for EVERY failure —
   * malformed, foreign, stale, unknown, and "you own nothing" alike. One code,
   * one message, one status, one body. Distinguishing them would assemble an
   * enumeration oracle out of honest error messages.
   */
  resolve(ownerUserId: string, ownedParties: readonly OwnedSubscriberParty[], supplied: string): OwnedSubscriberParty {
    const matched = resolveWorkspaceReference(
      this.secret,
      ownerUserId,
      ownedParties as readonly WorkspaceParty[],
      supplied,
      (candidate, value) => this.matchesReference(candidate, value),
    );

    if (!matched) throw new SubscriptionSellerNotEligibleException();
    return matched as OwnedSubscriberParty;
  }
}
