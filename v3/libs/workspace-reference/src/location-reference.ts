import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The opaque location reference -- V3.3 Story #108 (`#44b`), ADR-049 section 3.4.
 *
 * ## Why this is a sibling of `workspace-reference.ts`, not an edit to it
 *
 * ADR-049 section 3.4 and #108's issue require a `locationRef` that is
 * **separately domain-separated**, so `WORKSPACE_REFERENCE_DOMAIN`'s golden test
 * stays **byte-identical** and a `locationRef` presented where a `workspaceRef`
 * is expected can never match. The safe way to get that is a second construction
 * with its own domain prefix and its own arity, sharing nothing mutable with the
 * workspace primitive:
 *
 *  - `workspace-reference.ts` is not touched. Its domain prefix, length-prefixed
 *    encoding, digest, framing and golden vectors are unchanged, so every
 *    reference #69 and #72 ever issued still resolves.
 *  - This file imports **only `node:crypto`**, exactly as that one does, and a
 *    spec asserts it. The three-line `lengthPrefixed` helper is re-stated here
 *    rather than imported, so there is no shared module whose edit could reach
 *    both -- the netstring framing is trivial and self-evidently identical, while
 *    the MAC construction that actually matters is bound to a **different domain
 *    string and a different field arity** and therefore cannot collide.
 *
 * `V33-DEC-020`'s "no second secret" holds: this uses the **same**
 * `WORKSPACE_REFERENCE_SECRET` binding (fed from `WORKSPACE_REFERENCE_HMAC_SECRET`),
 * because domain separation by prefix already gives every property a second
 * secret would, and two secrets are two things to rotate and misconfigure.
 *
 * ## This is NOT an authorization token
 *
 * Identical reasoning to `workspace-reference.ts`: a `locationRef` is presented
 * and **matched**, never looked up from. `resolveLocationReference` is handed the
 * caller's currently live-owned locations, recomputes each reference, and
 * compares in constant time. A reference for a location the caller no longer
 * owns, or for another owner's session, simply stops matching -- revocation
 * needs no mechanism.
 */

/**
 * The location-reference domain-separation prefix.
 *
 * Deliberately distinct from `WORKSPACE_REFERENCE_DOMAIN`
 * (`beauclick.workspace-reference.v1`). Because the prefix is the first field of
 * the MAC input, a `locationRef` and a `workspaceRef` computed from otherwise
 * identical material are different 43-character strings, and neither resolver can
 * ever accept the other's value.
 *
 * Changing this string invalidates every outstanding `locationRef`. It is pinned
 * by a golden test for that reason.
 */
export const LOCATION_REFERENCE_DOMAIN = 'beauclick.location-reference.v1';

/** SHA-256 is 32 bytes; 32 bytes unpadded base64url is 43 characters. Fixed. */
export const LOCATION_REFERENCE_LENGTH = 43;

/** The closed character and length contract, validated before any use. */
export const LOCATION_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `<byteLength>:<value>`, so the concatenation below cannot be re-split two ways.
 *
 * Re-stated rather than imported from `workspace-reference.ts`: keeping this file
 * on `node:crypto` alone is what a spec there asserts, and the framing is a
 * one-liner whose correctness is self-evident. The domain prefix and field arity
 * are what actually separate the two constructions.
 */
function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * The MAC input.
 *
 * Exported so a test can prove the encoding is injective rather than assume it.
 * It CONTAINS raw identity -- the owner's user id, the organisation id and the
 * location id -- and must never be logged, returned, or put in a metric label.
 *
 * Every field is length-prefixed for the canonicalisation reason
 * `workspace-reference.ts` documents: `owner + business + location` concatenated
 * would let two distinct triples collide. Netstring framing makes the parse
 * forced.
 *
 * The MAC binds the authenticated **owner**, the **organisation** and the
 * **location** together (ADR-049 section 3.4): a reference minted for one
 * owner's location does not match another owner's session, and a reference for
 * location X under business A does not match location X quoted under business B.
 */
export function locationReferenceInput(ownerUserId: string, businessId: string, locationId: string): string {
  return [
    LOCATION_REFERENCE_DOMAIN,
    lengthPrefixed(ownerUserId),
    lengthPrefixed(businessId),
    lengthPrefixed(locationId),
  ].join('|');
}

export function deriveLocationReference(
  secret: string,
  ownerUserId: string,
  businessId: string,
  locationId: string,
): string {
  return createHmac('sha256', secret)
    .update(locationReferenceInput(ownerUserId, businessId, locationId), 'utf8')
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
export function locationReferencesMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** One of the caller's own locations, as the resolver sees it. */
export interface OwnedLocationRef {
  readonly businessId: string;
  readonly locationId: string;
}

/**
 * The one live-owned location a supplied reference names, or `null`.
 *
 * **Returns null; never throws a refusal.** The `business` domain maps "no
 * match" to its own single non-enumerating refusal (`NOT_FOUND_OR_NOT_YOURS`),
 * so this shared function never decides what a failed match means to a caller.
 *
 * The order is the security property, identical to `resolveWorkspaceReference`:
 *
 *  1. the caller's CURRENTLY live-owned locations arrive as an argument,
 *     enumerated live by `business` against `businesses.owner_id`;
 *  2. the supplied value is validated against the closed format contract;
 *  3. each candidate reference is computed server-side, here;
 *  4. each is compared in constant time;
 *  5. only a match yields a location.
 *
 * There is no query on this path, so "a location is never looked up from a
 * caller-supplied reference" is a property of the code.
 *
 * @param compare the comparison seam. Defaults to `locationReferencesMatch`; a
 * test passes its own so it can prove the constant-time path is what decides.
 */
export function resolveLocationReference<L extends OwnedLocationRef>(
  secret: string,
  ownerUserId: string,
  ownedLocations: readonly L[],
  supplied: string,
  compare: (candidate: string, supplied: string) => boolean = locationReferencesMatch,
): L | null {
  // Checked BEFORE any candidate is computed, so a caller cannot make the server
  // do HMAC work by sending rubbish.
  if (!LOCATION_REFERENCE_PATTERN.test(supplied)) return null;

  // Every candidate is compared, so the work done does not depend on WHICH
  // location matched.
  let matched: L | null = null;
  for (const location of ownedLocations) {
    if (compare(deriveLocationReference(secret, ownerUserId, location.businessId, location.locationId), supplied)) {
      matched = location;
    }
  }
  return matched;
}
