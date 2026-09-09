import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The opaque resource reference -- V3.3 Story #110 (`#110a`), `V33-DEC-034` R5
 * and ADR-049 section 3.4.
 *
 * ## Why this is a third sibling, not an edit to either existing file
 *
 * `V33-DEC-034` R5 requires a `resourceRef` with its **own** domain constant, so
 * `WORKSPACE_REFERENCE_DOMAIN` and `LOCATION_REFERENCE_DOMAIN` golden tests both
 * stay **byte-identical** and no reference can ever be accepted where another is
 * expected. The safe way to get that is a third construction with its own domain
 * prefix and its own arity, sharing nothing mutable with either primitive:
 *
 *  - `workspace-reference.ts` and `location-reference.ts` are not touched. Their
 *    domain prefixes, encodings, digests, framing and golden vectors are
 *    unchanged, so every reference #69, #72 and #108 ever issued still resolves.
 *  - This file imports **only `node:crypto`**, exactly as both do, and a spec
 *    asserts it. The three-line `lengthPrefixed` helper is re-stated here rather
 *    than imported, for the reason `location-reference.ts` records: there is then
 *    no shared module whose edit could reach all three. The netstring framing is
 *    trivial and self-evidently identical, while the MAC construction that
 *    actually matters is bound to a **different domain string and a different
 *    field arity** and therefore cannot collide.
 *
 * `V33-DEC-020`'s "no second secret" holds: this uses the **same**
 * `WORKSPACE_REFERENCE_SECRET` binding, because domain separation by prefix
 * already gives every property a second secret would, and two secrets are two
 * things to rotate and misconfigure. The existing secret is neither rotated nor
 * renamed by this story.
 *
 * ## This is NOT an authorization token
 *
 * Identical reasoning to both siblings: a `resourceRef` is presented and
 * **matched**, never looked up from. `resolveResourceReference` is handed the
 * caller's currently live-owned resources, recomputes each reference, and
 * compares in constant time. A reference for a resource the caller no longer
 * owns, or for another owner's session, simply stops matching -- revocation needs
 * no mechanism. **No query is ever issued by `resourceRef`**, and no raw resource
 * uuid is ever exposed over HTTP.
 */

/**
 * The resource-reference domain-separation prefix.
 *
 * Deliberately distinct from `WORKSPACE_REFERENCE_DOMAIN`
 * (`beauclick.workspace-reference.v1`) and `LOCATION_REFERENCE_DOMAIN`
 * (`beauclick.location-reference.v1`). Because the prefix is the first field of
 * the MAC input, a `resourceRef`, a `locationRef` and a `workspaceRef` computed
 * from otherwise identical material are three different 43-character strings, and
 * no resolver can ever accept another's value.
 *
 * Changing this string invalidates every outstanding `resourceRef`. It is pinned
 * by a golden test for that reason.
 */
export const RESOURCE_REFERENCE_DOMAIN = 'beauclick.resource-reference.v1';

/** SHA-256 is 32 bytes; 32 bytes unpadded base64url is 43 characters. Fixed. */
export const RESOURCE_REFERENCE_LENGTH = 43;

/** The closed character and length contract, validated before any use. */
export const RESOURCE_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `<byteLength>:<value>`, so the concatenation below cannot be re-split two ways.
 *
 * Re-stated rather than imported, for the reason the file docblock gives: keeping
 * this module on `node:crypto` alone is what a spec asserts, and the framing is a
 * one-liner whose correctness is self-evident.
 */
function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * The MAC input.
 *
 * Exported so a test can prove the encoding is injective rather than assume it.
 * It CONTAINS raw identity -- the owner's user id, the organisation id, the
 * location id and the resource id -- and must never be logged, returned, or put
 * in a metric label.
 *
 * **Four bound fields**, one more than `locationReferenceInput`'s three. The MAC
 * binds the authenticated **owner**, the **organisation**, the **location** and
 * the **resource** together (`V33-DEC-034` R5), so a reference minted for one
 * owner's resource does not match another owner's session; a reference for
 * resource X under location A does not match resource X quoted under location B;
 * and a reference for location L under business A does not match the same
 * location quoted under business B.
 *
 * Every field is length-prefixed for the canonicalisation reason both siblings
 * document: concatenation alone would let two distinct tuples collide. Netstring
 * framing makes the parse forced.
 */
export function resourceReferenceInput(
  ownerUserId: string,
  businessId: string,
  locationId: string,
  resourceId: string,
): string {
  return [
    RESOURCE_REFERENCE_DOMAIN,
    lengthPrefixed(ownerUserId),
    lengthPrefixed(businessId),
    lengthPrefixed(locationId),
    lengthPrefixed(resourceId),
  ].join('|');
}

export function deriveResourceReference(
  secret: string,
  ownerUserId: string,
  businessId: string,
  locationId: string,
  resourceId: string,
): string {
  return createHmac('sha256', secret)
    .update(resourceReferenceInput(ownerUserId, businessId, locationId, resourceId), 'utf8')
    .digest('base64url');
}

/**
 * Constant-time equality for two references.
 *
 * `crypto.timingSafeEqual` THROWS on buffers of different lengths, which would
 * both leak the expected length and turn a wrong-length input into a 500 -- and
 * the difference between a 500 and a 404 is itself the oracle this comparison
 * avoids. Hashing both sides to a fixed 32 bytes first removes it. The digest is
 * not stored, transmitted or a credential; it exists for one comparison.
 */
export function resourceReferencesMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** One of the caller's own resources, as the resolver sees it. */
export interface OwnedResourceRef {
  readonly businessId: string;
  readonly locationId: string;
  readonly resourceId: string;
}

/**
 * The one live-owned resource a supplied reference names, or `null`.
 *
 * **Returns null; never throws a refusal.** The `business` domain maps "no match"
 * to its own single non-enumerating refusal (`NOT_FOUND_OR_NOT_YOURS`), so this
 * shared function never decides what a failed match means to a caller.
 *
 * The order is the security property, identical to `resolveLocationReference`:
 *
 *  1. the caller's CURRENTLY live-owned resources arrive as an argument,
 *     enumerated live by `business` against `businesses.owner_id`;
 *  2. the supplied value is validated against the closed format contract;
 *  3. each candidate reference is computed server-side, here;
 *  4. each is compared in constant time;
 *  5. only a match yields a resource.
 *
 * There is no query on this path, so "a resource is never looked up from a
 * caller-supplied reference" is a property of the code.
 *
 * @param compare the comparison seam. Defaults to `resourceReferencesMatch`; a
 * test passes its own so it can prove the constant-time path is what decides.
 */
export function resolveResourceReference<R extends OwnedResourceRef>(
  secret: string,
  ownerUserId: string,
  ownedResources: readonly R[],
  supplied: string,
  compare: (candidate: string, supplied: string) => boolean = resourceReferencesMatch,
): R | null {
  // Checked BEFORE any candidate is computed, so a caller cannot make the server
  // do HMAC work by sending rubbish.
  if (!RESOURCE_REFERENCE_PATTERN.test(supplied)) return null;

  // Every candidate is compared, so the work done does not depend on WHICH
  // resource matched.
  let matched: R | null = null;
  for (const resource of ownedResources) {
    if (
      compare(
        deriveResourceReference(secret, ownerUserId, resource.businessId, resource.locationId, resource.resourceId),
        supplied,
      )
    ) {
      matched = resource;
    }
  }
  return matched;
}
