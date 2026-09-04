import { createHmac } from 'node:crypto';

import {
  WORKSPACE_REFERENCE_DOMAIN,
  WORKSPACE_REFERENCE_LENGTH,
  WORKSPACE_REFERENCE_PATTERN,
  WorkspaceReferenceService,
  deriveWorkspaceReference,
  workspaceReferenceInput,
  workspaceReferencesMatch,
} from './workspace-reference';
import { SubscriptionSellerNotEligibleException } from '../subscription/seller-subscription.exceptions';
import type { OwnedSubscriberParty } from '../subscription/owned-subscriber-party.port';

/**
 * The `workspaceRef` construction — Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## Why these are fast tests and the ownership half is not
 *
 * Everything here is pure: a derivation, a format contract, a comparison. None
 * of it touches a database, so proving it against one would be slower without
 * being stronger. What a database IS needed for — that resolution enumerates
 * LIVE ownership, that a staff member enumerates nothing, that a refusal is
 * byte-identical over HTTP — is in `seller-subscription-surface.pg-spec.ts`,
 * because none of those can be observed without real rows.
 *
 * ## The secrets here are literals, and that is deliberate
 *
 * They exist only in this file, they are not the development fallback, and they
 * are not a real value from anywhere. A test that read the real secret would
 * both fail on a machine that has not configured one and put a production
 * credential in a process that prints its own failures.
 */

const SECRET_A = 'unit-test-workspace-secret-a';
const SECRET_B = 'unit-test-workspace-secret-b';

const OWNER = '018f4b1a-0000-7000-8000-000000000001';
const OTHER_OWNER = '018f4b1a-0000-7000-8000-000000000002';
const PROFESSIONAL: OwnedSubscriberParty = { partyType: 'professional', partyId: '018f4b1a-0000-7000-8000-0000000000aa' };
const BUSINESS: OwnedSubscriberParty = { partyType: 'business', partyId: '018f4b1a-0000-7000-8000-0000000000bb' };

describe('workspaceRef — construction and format', () => {
  it('is exactly 43 base64url characters, and the constant says so', () => {
    const reference = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);

    expect(reference).toHaveLength(WORKSPACE_REFERENCE_LENGTH);
    expect(WORKSPACE_REFERENCE_LENGTH).toBe(43);
    expect(reference).toMatch(WORKSPACE_REFERENCE_PATTERN);
    // No padding, and none of base64's two non-URL-safe characters. A `+`, `/`
    // or `=` in a path segment is a percent-encoding problem waiting to be
    // discovered by a client.
    expect(reference).not.toMatch(/[+/=]/);
  });

  it('rejects everything that is not exactly that shape', () => {
    const reference = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);

    // The negative control set. Each is a real shape a caller could send, and
    // the pattern must refuse every one -- including the two that differ from a
    // valid reference by a single character.
    expect(WORKSPACE_REFERENCE_PATTERN.test('')).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(reference.slice(0, 42))).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(`${reference}x`)).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(`${reference.slice(0, 42)}+`)).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(`${reference.slice(0, 42)}/`)).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(`${reference.slice(0, 41)}..`)).toBe(false);
    expect(WORKSPACE_REFERENCE_PATTERN.test(PROFESSIONAL.partyId)).toBe(false);
    // The positive control, so the five refusals above are not all vacuously
    // true against a pattern that refuses everything.
    expect(WORKSPACE_REFERENCE_PATTERN.test(reference)).toBe(true);
  });

  it('is stable for the same owner and workspace', () => {
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL),
    );
  });

  it('differs for two workspaces of the same owner', () => {
    // The dual-owner case `V33-DEC-019` exists for. One reference for two
    // workspaces would make the collection unroutable.
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, BUSINESS),
    );
  });

  it('differs for two owners of the same workspace', () => {
    // The property that makes a stolen reference inert: it is bound to the
    // session that will present it, not only to the party it names.
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OTHER_OWNER, PROFESSIONAL),
    );
  });

  it('differs under a different secret, so rotation invalidates outstanding references', () => {
    // `V33-DEC-019` accepts exactly this: single key, rotation invalidates, and
    // clients recover by re-reading the collection. Asserted so the runbook's
    // claim is a tested one.
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).not.toBe(
      deriveWorkspaceReference(SECRET_B, OWNER, PROFESSIONAL),
    );
  });

  it('exposes no raw identity — not the owner, not the party, not the type', () => {
    const reference = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);
    const decoded = Buffer.from(reference, 'base64url').toString('utf8');

    for (const secretish of [OWNER, PROFESSIONAL.partyId, 'professional', SECRET_A]) {
      expect(reference).not.toContain(secretish);
      expect(decoded).not.toContain(secretish);
    }
    // A digest, not an envelope: 32 bytes of MAC with nothing recoverable from
    // it. `Buffer.from(...).length` is the discovery half -- if this ever
    // stopped being 32 the value would have become a container.
    expect(Buffer.from(reference, 'base64url')).toHaveLength(32);
  });
});

describe('workspaceRef — the MAC input', () => {
  it('is domain-separated with a fixed versioned prefix', () => {
    expect(workspaceReferenceInput(OWNER, PROFESSIONAL).startsWith(`${WORKSPACE_REFERENCE_DOMAIN}|`)).toBe(true);
    expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
  });

  it('is a plain HMAC-SHA-256 of that input, and nothing else is mixed in', () => {
    // Recomputed independently rather than compared against the function's own
    // output. A test that calls the implementation twice proves determinism and
    // nothing about WHAT was computed.
    const expected = createHmac('sha256', SECRET_A)
      .update(workspaceReferenceInput(OWNER, PROFESSIONAL), 'utf8')
      .digest('base64url');

    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).toBe(expected);
  });

  it('length-prefixes every field, so two different triples cannot collide', () => {
    /*
     * The canonicalisation bug this encoding exists to prevent, made concrete.
     *
     * Under naive concatenation, an owner id ending in `x` followed by a party
     * id, and an owner id one character shorter followed by a party id one
     * character longer, produce the SAME bytes -- and therefore the same
     * reference for two different workspaces.
     *
     * The pair below is exactly that collision. Both halves are asserted: the
     * naive form really does collide (so this is not a straw man), and the real
     * encoding really does not.
     */
    const left = { owner: 'aa', party: { partyType: 'business' as const, partyId: 'bcc' } };
    const right = { owner: 'aab', party: { partyType: 'business' as const, partyId: 'cc' } };

    expect(left.owner + left.party.partyId).toBe(right.owner + right.party.partyId);

    expect(workspaceReferenceInput(left.owner, left.party)).not.toBe(
      workspaceReferenceInput(right.owner, right.party),
    );
    expect(deriveWorkspaceReference(SECRET_A, left.owner, left.party)).not.toBe(
      deriveWorkspaceReference(SECRET_A, right.owner, right.party),
    );
  });
});

describe('workspaceRef — the constant-time comparison', () => {
  it('is correct for equal and unequal values', () => {
    expect(workspaceReferencesMatch('abc', 'abc')).toBe(true);
    expect(workspaceReferencesMatch('abc', 'abd')).toBe(false);
  });

  it('returns false rather than THROWING on a length mismatch', () => {
    /*
     * The non-vacuity control, and the reason this wrapper exists at all.
     *
     * `crypto.timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on
     * buffers of different lengths. Used directly, a caller sending a
     * three-character reference would get a 500 -- and the difference between a
     * 500 and a 404 is itself the length oracle the comparison was chosen to
     * avoid.
     *
     * Hashing both sides to a fixed 32 bytes first is what removes it, and this
     * case is what proves the hashing is actually there: delete it and this
     * throws.
     */
    expect(() => workspaceReferencesMatch('a', 'abcdefghijklmnop')).not.toThrow();
    expect(workspaceReferencesMatch('a', 'abcdefghijklmnop')).toBe(false);
    expect(workspaceReferencesMatch('', 'x')).toBe(false);
  });
});

describe('WorkspaceReferenceService.resolve', () => {
  const service = new WorkspaceReferenceService(SECRET_A);
  const owned = [BUSINESS, PROFESSIONAL];

  it('returns the party whose recomputed reference matches', () => {
    expect(service.resolve(OWNER, owned, service.referenceFor(OWNER, PROFESSIONAL))).toEqual(PROFESSIONAL);
    expect(service.resolve(OWNER, owned, service.referenceFor(OWNER, BUSINESS))).toEqual(BUSINESS);
  });

  it('refuses a reference belonging to another owner', () => {
    const stolen = deriveWorkspaceReference(SECRET_A, OTHER_OWNER, PROFESSIONAL);
    expect(() => service.resolve(OWNER, owned, stolen)).toThrow(SubscriptionSellerNotEligibleException);
  });

  it('refuses a party the caller no longer owns', () => {
    // The live-ownership property, at the unit level: the reference is
    // perfectly valid and correctly signed, and it resolves to nothing because
    // the party is not in the enumerated set.
    const valid = service.referenceFor(OWNER, BUSINESS);
    expect(() => service.resolve(OWNER, [PROFESSIONAL], valid)).toThrow(SubscriptionSellerNotEligibleException);
  });

  it('refuses malformed, empty and random references with the same exception', () => {
    const valid = service.referenceFor(OWNER, PROFESSIONAL);
    for (const supplied of ['', 'x', valid.slice(0, 42), `${valid}x`, PROFESSIONAL.partyId, 'A'.repeat(43)]) {
      expect(() => service.resolve(OWNER, owned, supplied)).toThrow(SubscriptionSellerNotEligibleException);
    }
  });

  it('refuses everything when the caller owns nothing', () => {
    expect(() => service.resolve(OWNER, [], service.referenceFor(OWNER, PROFESSIONAL))).toThrow(
      SubscriptionSellerNotEligibleException,
    );
  });

  it('never looks a party up FROM the reference — it compares against every owned candidate', () => {
    /*
     * The non-vacuous proof that the constant-time seam is what decides.
     *
     * `matchesReference` is a prototype method precisely so it can be observed.
     * Two things are asserted, and the second is what makes this more than a
     * call count:
     *
     *   1. it is invoked once per OWNED party -- i.e. the resolution enumerates
     *      and compares rather than parsing the reference or querying by it;
     *   2. forcing it to `false` makes a valid reference refuse. If `resolve`
     *      had any other path to a party -- a `===`, a lookup, a cache -- this
     *      would still return one, and this case would fail.
     */
    const spy = jest.spyOn(WorkspaceReferenceService.prototype, 'matchesReference');
    try {
      const valid = service.referenceFor(OWNER, PROFESSIONAL);

      expect(service.resolve(OWNER, owned, valid)).toEqual(PROFESSIONAL);
      expect(spy).toHaveBeenCalledTimes(owned.length);

      spy.mockReturnValue(false);
      expect(() => service.resolve(OWNER, owned, valid)).toThrow(SubscriptionSellerNotEligibleException);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not reach the comparison at all for a malformed reference', () => {
    // The format contract is checked BEFORE any candidate is computed, so a
    // caller cannot make the server do HMAC work by sending rubbish.
    const spy = jest.spyOn(WorkspaceReferenceService.prototype, 'matchesReference');
    try {
      expect(() => service.resolve(OWNER, owned, 'not-a-reference')).toThrow(SubscriptionSellerNotEligibleException);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
