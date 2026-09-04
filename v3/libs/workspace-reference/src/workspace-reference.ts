import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The opaque workspace reference — Story #69 (`V33-DEC-019`), shared by
 * `V33-DEC-020`.
 *
 * ## Why this is a shared library and not a copy
 *
 * Story #69 built this inside `services/commercial-policy`, where it was the
 * only consumer. Bug #72 needs the identical mechanism on the finance surface,
 * and `@nx/enforce-module-boundaries` restricts `scope:financial` to
 * `scope:shared` alone — so `financial` cannot import `commercial-policy`, and
 * `V33-DEC-020` forbids duplicating a cryptographic construction, because two
 * implementations of one MAC are one waiting to disagree.
 *
 * So the primitive moved here **byte-for-byte**. Every reference #69 ever
 * issued still resolves: the domain prefix, the length-prefixed encoding, the
 * key and the digest are unchanged, and `workspace-reference.golden.spec.ts`
 * pins the exact output of fixed inputs so a later edit cannot quietly
 * invalidate a live reference.
 *
 * ## What this library deliberately cannot do
 *
 * It queries no database. It imports no domain — neither `commercial-policy`
 * nor `financial`, and nothing from `@nestjs/*`. It performs **no
 * authorization**: `resolveWorkspaceReference` is handed the parties the caller
 * already owns and returns which of them matched, or null. Deciding who owns
 * what, and what a non-match means, stays with the domain that asked.
 *
 * That is the whole reason it is safe to share. A shared thing that made an
 * authorization decision would be one place where two domains' security models
 * silently became one.
 *
 * ## This is NOT an authorization token
 *
 * A capability token is presented and believed. This is presented and MATCHED:
 * the caller's currently owned parties are enumerated live, their references
 * recomputed, and the supplied value compared against them in constant time.
 * Nothing is ever looked up FROM a reference, so a reference stolen from
 * another seller is inert — its owner half does not match the thief's session.
 *
 * Revocation therefore needs no mechanism: a party sold, deleted or erased
 * between two calls stops matching because it stops being enumerated.
 */

/**
 * The domain-separation prefix.
 *
 * Versioned, and **shared across every surface on purpose** (`V33-DEC-020`).
 * One workspace has one opaque id product-wide, which is what a future session
 * workspace context can build on; a per-domain prefix would give the same
 * workspace two different ids and buy no isolation, because the reference is
 * not a credential and live ownership is re-verified on every surface anyway.
 *
 * Changing this string invalidates every outstanding reference on every
 * surface. It is pinned by a golden test for that reason.
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

/**
 * The injection token for the secret, so both domains consume ONE binding.
 *
 * A token rather than a `config.get(...)` inside each service: the requirement
 * that this be a dedicated secret is then visible at the single place it is
 * bound, instead of being a default two modules could independently point at
 * `JWT_ACCESS_SECRET`.
 */
export const WORKSPACE_REFERENCE_SECRET = Symbol('BEAUCLICK_WORKSPACE_REFERENCE_SECRET');

/**
 * The development fallback, and the reason it is safe.
 *
 * Distinct from the `dev-only-insecure-secret-override-in-env` literal
 * `app.module.ts` falls back to for the JWT: sharing that one would make this
 * secret EQUAL the token-signing secret on every developer machine, which is
 * exactly the reuse `env.validation.ts` refuses in production — so the
 * dedicated-secret property would hold only where it is checked.
 *
 * Both `dev-only` and `insecure` are in `FORBIDDEN_SECRET_FRAGMENTS`, so a
 * deployment carrying this value cannot start under `NODE_ENV=production`.
 */
export const DEVELOPMENT_WORKSPACE_REFERENCE_SECRET = 'dev-only-insecure-workspace-reference-secret-override-in-env';

/**
 * A seller workspace, as the reference sees it.
 *
 * Deliberately structural rather than an import from either domain:
 * `OwnedSubscriberParty` and `FinancialParty` are the same shape for the same
 * reason, and depending on either would recreate the boundary this library
 * exists to remove.
 *
 * `partyType` is `professional | business` and **never** `platform`.
 * `financial.ledger_entries` admits a `platform` party for the commission side
 * of a booking; it is not a seller workspace, nobody owns it, and a reference
 * must never be minted for it. `assertSellerWorkspaceParty` is where that is
 * enforced rather than assumed.
 */
export interface WorkspaceParty {
  readonly partyType: 'professional' | 'business';
  readonly partyId: string;
}

/** The party types a workspace reference may be issued for. */
export const WORKSPACE_PARTY_TYPES = ['professional', 'business'] as const;

export class WorkspaceReferenceError extends Error {}

/**
 * Refuses to mint a reference for anything that is not a seller workspace.
 *
 * A server-side invariant, not a caller-facing refusal: reaching it means a
 * domain passed `platform` (or a future third party type) into a mechanism
 * that has no owner to bind it to, and producing a reference anyway would
 * create a routable handle to rows nobody owns.
 */
export function assertSellerWorkspaceParty(party: { partyType: string; partyId: string }): asserts party is WorkspaceParty {
  if (!(WORKSPACE_PARTY_TYPES as readonly string[]).includes(party.partyType)) {
    throw new WorkspaceReferenceError(
      `a workspace reference may only be issued for a seller workspace, not "${party.partyType}"`,
    );
  }
}

/** `<byteLength>:<value>`, so the concatenation below cannot be re-split two ways. */
function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * The MAC input.
 *
 * Exported so a test can prove the encoding is injective rather than assume it.
 * It CONTAINS raw identity — the owner's user id and the raw party id — and
 * must never be logged, returned, or put in a metric label.
 *
 * ## Why every field is length-prefixed
 *
 * `owner + partyType + partyId` concatenated is a canonicalisation bug waiting
 * to happen: an owner id ending in `x` followed by a party id, and an owner id
 * one character shorter followed by a party id one character longer, produce
 * the same byte string — and then two different workspaces share one reference.
 * Netstring framing makes the parse forced, so no two distinct triples can
 * collide.
 */
export function workspaceReferenceInput(ownerUserId: string, party: WorkspaceParty): string {
  return [
    WORKSPACE_REFERENCE_DOMAIN,
    lengthPrefixed(ownerUserId),
    lengthPrefixed(party.partyType),
    lengthPrefixed(party.partyId),
  ].join('|');
}

export function deriveWorkspaceReference(secret: string, ownerUserId: string, party: WorkspaceParty): string {
  assertSellerWorkspaceParty(party);
  return createHmac('sha256', secret).update(workspaceReferenceInput(ownerUserId, party), 'utf8').digest('base64url');
}

/**
 * Constant-time equality for two references.
 *
 * `crypto.timingSafeEqual` THROWS on buffers of different lengths, which would
 * both leak the expected length and turn a wrong-length input into a 500 — and
 * the difference between a 500 and a 404 is itself the oracle this comparison
 * was chosen to avoid. Hashing both sides to a fixed 32 bytes first removes it.
 *
 * Hashing does not weaken the comparison: the digest is not stored, not
 * transmitted and not a credential — it exists for the length of one
 * comparison, so a preimage attack on it would be an attack on a value the
 * attacker already holds.
 */
export function workspaceReferencesMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * The one owned party a supplied reference names, or `null`.
 *
 * **Returns null; never throws a refusal.** Each domain maps "no match" to its
 * own non-enumerating refusal — `SUBSCRIPTION_SELLER_NOT_ELIGIBLE` for
 * subscriptions, `NOT_FOUND_OR_NOT_YOURS` for finance — so a shared library
 * never decides what a failed match means to a caller.
 *
 * The order is the security property:
 *
 *  1. the caller's CURRENTLY owned parties arrive as an argument, enumerated
 *     live by the domain;
 *  2. the supplied value is validated against the closed format contract;
 *  3. candidates are computed server-side, here;
 *  4. each is compared in constant time;
 *  5. only a match yields a party.
 *
 * There is no query anywhere on this path, so "a party is never looked up from
 * a caller-supplied reference" is a property of the code rather than a rule
 * somebody has to remember.
 *
 * @param compare the comparison seam. Defaults to `workspaceReferencesMatch`;
 * a domain passes its own bound method so a test can spy on it and prove the
 * constant-time path is what decides, which an assertion about the outcome
 * alone cannot show.
 */
export function resolveWorkspaceReference<P extends WorkspaceParty>(
  secret: string,
  ownerUserId: string,
  ownedParties: readonly P[],
  supplied: string,
  compare: (candidate: string, supplied: string) => boolean = workspaceReferencesMatch,
): P | null {
  // Checked BEFORE any candidate is computed, so a caller cannot make the
  // server do HMAC work by sending rubbish.
  if (!WORKSPACE_REFERENCE_PATTERN.test(supplied)) return null;

  // Not a `find`, and not an early return: every candidate is compared, so the
  // work done does not depend on WHICH party matched. With at most two owned
  // parties the saving would be immaterial anyway, and the uniform shape is
  // worth more than it.
  let matched: P | null = null;
  for (const party of ownedParties) {
    if (compare(deriveWorkspaceReference(secret, ownerUserId, party), supplied)) matched = party;
  }
  return matched;
}
