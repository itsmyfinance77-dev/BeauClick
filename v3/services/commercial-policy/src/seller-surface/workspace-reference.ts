import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { OwnedSubscriberParty } from '../subscription/owned-subscriber-party.port';
import { SubscriptionSellerNotEligibleException } from '../subscription/seller-subscription.exceptions';

/**
 * The opaque workspace reference — Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## What problem this solves, and why an id could not
 *
 * `V33-DEC-019` made the seller subscription surface a COLLECTION, because
 * `provider.professionals.owner_id` and `business.businesses.owner_id` are
 * independent unique indexes and one user may own both. A collection needs a
 * per-entry routing segment, and every obvious candidate is forbidden: a
 * `professionalId`, `businessId`, `partyId`, `subscriptionId`, `ownerId` or
 * `userId` in a URL is raw database identity handed to a browser, and
 * `V33-DEC-018` resolves the subscriber party server-side precisely so that a
 * client-supplied one is never trusted.
 *
 * So the segment is DERIVED rather than stored: an HMAC over the authenticated
 * owner and the owned party, which the server recomputes for the parties a
 * caller actually owns and compares against what they sent. No column, no
 * table, no schema change — which is what let `V33-DEC-019` close this contract
 * without reopening ADR-042's.
 *
 * ## This is NOT an authorization token, and the distinction is load-bearing
 *
 * A capability token is presented and believed. This is presented and MATCHED:
 * every request re-enumerates the caller's currently owned parties, recomputes
 * their references, and looks for the one the caller sent. Nothing is ever
 * looked up FROM a reference.
 *
 * The consequence is the property the story asks for: a reference stolen from
 * another seller is inert. Its owner half does not match the thief's session,
 * so the thief's recomputed candidates never equal it — and the refusal is
 * byte-identical to the one a random string produces.
 *
 * It also means revocation needs no mechanism. Ownership is re-read inside the
 * request, so a party sold, deleted or erased between two calls stops matching
 * because it stops being enumerated, not because anything expired.
 *
 * ## Domain separation and unambiguous encoding
 *
 * Two mistakes this file exists not to make.
 *
 * **Domain separation.** The MAC input carries a fixed, versioned prefix, so a
 * value produced here can never be mistaken for — or replayed as — a MAC
 * computed for another purpose under a key that was reused. The
 * `WORKSPACE_REFERENCE_HMAC_SECRET` contract already forbids that reuse and
 * `env.validation.ts` refuses to boot on it; the prefix means a future mistake
 * is still not exploitable.
 *
 * **Unambiguous encoding.** `owner + partyType + partyId` concatenated is a
 * canonicalisation bug waiting to happen: two different triples can produce one
 * byte string, and then two different workspaces share a reference. Each field
 * is therefore length-prefixed (netstring form, `<byteLength>:<value>`), which
 * makes the encoding injective — the parse is forced, so no two distinct
 * triples can collide.
 *
 * ## Single key, and rotation is a documented outcome rather than a subsystem
 *
 * `V33-DEC-019` accepts single-key rotation: rotating invalidates every
 * outstanding reference, and clients recover by repeating initialization or the
 * collection read. No current/previous-key framework is built, because the
 * repository has no such convention to follow and inventing one would add a key
 * schedule nobody has decided how to operate. `docs/runbooks/SECRET_ROTATION.md`
 * records the operational consequence.
 */

/**
 * The domain-separation prefix.
 *
 * Versioned so a future change to the encoding is a NEW prefix rather than a
 * silent reinterpretation of the same bytes.
 */
export const WORKSPACE_REFERENCE_DOMAIN = 'beauclick.workspace-reference.v1';

/**
 * The exact length of a reference: SHA-256 is 32 bytes, and 32 bytes in
 * unpadded base64url is 43 characters. Fixed, so the contract is closed and a
 * length is never evidence of anything.
 */
export const WORKSPACE_REFERENCE_LENGTH = 43;

/** The closed character and length contract, validated before any use. */
export const WORKSPACE_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `<byteLength>:<value>`, so the concatenation below cannot be re-split two ways. */
function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * The MAC input.
 *
 * Exported for the suite, which proves the encoding is injective rather than
 * assuming it. It CONTAINS raw identity and must never be logged, returned or
 * put in a metric label — the surface never handles it, and the boundary suite
 * asserts that.
 */
export function workspaceReferenceInput(ownerUserId: string, party: OwnedSubscriberParty): string {
  return [
    WORKSPACE_REFERENCE_DOMAIN,
    lengthPrefixed(ownerUserId),
    lengthPrefixed(party.partyType),
    lengthPrefixed(party.partyId),
  ].join('|');
}

export function deriveWorkspaceReference(secret: string, ownerUserId: string, party: OwnedSubscriberParty): string {
  return createHmac('sha256', secret).update(workspaceReferenceInput(ownerUserId, party), 'utf8').digest('base64url');
}

/**
 * Constant-time equality for two references.
 *
 * The same shape — and for the same two reasons — as
 * `apps/api/src/observability/timing-safe-equal.ts`: `timingSafeEqual` THROWS
 * on unequal lengths, which would both leak the expected length and turn a
 * wrong-length input into a 500, so both sides are hashed to a fixed 32 bytes
 * first. Written here rather than imported because `services/*` may not import
 * from `apps/api` (ADR-011, enforced by lint).
 *
 * Exported as a NAMED SEAM so the suite can spy on it and prove the comparison
 * actually runs. An assertion that a private call happened is not evidence.
 */
export function workspaceReferencesMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * The secret, bound in the composition root.
 *
 * A token rather than a `ConfigService` read inside the service, so the fact
 * that this class needs a DEDICATED secret is visible at the wiring rather than
 * buried in a `config.get(...)` that somebody could point at `JWT_ACCESS_SECRET`
 * without anything noticing.
 */
export const WORKSPACE_REFERENCE_SECRET = Symbol('BEAUCLICK_WORKSPACE_REFERENCE_SECRET');

/**
 * Derives references, and resolves one back to a party the caller OWNS.
 *
 * The resolution order is the security property, and it is the order of
 * `resolve` below rather than a comment:
 *
 *  1. the caller is already authenticated — the guard ran before the handler;
 *  2. the caller's CURRENTLY owned parties were enumerated live, inside the
 *     request's own transaction, by #56a's ownership resolver;
 *  3. the candidate references are computed server-side, here;
 *  4. the supplied value is validated against the closed format contract;
 *  5. it is compared against every candidate in constant time;
 *  6. only a match yields a party.
 *
 * There is no query anywhere that takes a reference as a parameter. That is
 * what makes "a party is never looked up from a caller-supplied reference" a
 * property of the code rather than a rule somebody has to remember.
 */
@Injectable()
export class WorkspaceReferenceService {
  constructor(@Inject(WORKSPACE_REFERENCE_SECRET) private readonly secret: string) {}

  referenceFor(ownerUserId: string, party: OwnedSubscriberParty): string {
    return deriveWorkspaceReference(this.secret, ownerUserId, party);
  }

  /**
   * The comparison seam, as a METHOD rather than the free function directly.
   *
   * A module-level call compiles to a direct local reference, which no spy can
   * observe — so a test claiming "the constant-time comparison ran" could only
   * assert that the outcome was right, which a `===` would also satisfy. A
   * prototype method is patchable, so the suite can prove this is invoked once
   * per owned party AND that replacing it changes the result. That is the
   * difference between a test and a comment.
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
   * enumeration oracle out of honest error messages, which is exactly what that
   * exception's own docblock refuses.
   */
  resolve(ownerUserId: string, ownedParties: readonly OwnedSubscriberParty[], supplied: string): OwnedSubscriberParty {
    // Not a `find`, and not an early return: every candidate is compared, so
    // the work done does not depend on WHICH party matched. With at most two
    // owned parties the saving would be immaterial anyway, and the uniform
    // shape is worth more than it.
    let matched: OwnedSubscriberParty | null = null;

    if (WORKSPACE_REFERENCE_PATTERN.test(supplied)) {
      for (const party of ownedParties) {
        if (this.matchesReference(this.referenceFor(ownerUserId, party), supplied)) matched = party;
      }
    }

    if (!matched) throw new SubscriptionSellerNotEligibleException();
    return matched;
  }
}
