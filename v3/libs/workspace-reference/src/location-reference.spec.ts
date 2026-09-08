import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LOCATION_REFERENCE_DOMAIN,
  LOCATION_REFERENCE_LENGTH,
  LOCATION_REFERENCE_PATTERN,
  deriveLocationReference,
  locationReferenceInput,
  locationReferencesMatch,
  resolveLocationReference,
} from './location-reference';
import {
  WORKSPACE_REFERENCE_DOMAIN,
  WorkspaceParty,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
  workspaceReferenceInput,
} from './workspace-reference';

/**
 * V3.3 Story #108 (`#44b`) -- the opaque `locationRef`, ADR-049 section 3.4.
 *
 * The three properties this file exists to pin:
 *
 *  1. `locationRef` is its own construction with its own domain prefix, so a
 *     value that fixed inputs produce is pinned and a later edit fails HERE
 *     rather than silently invalidating an outstanding reference;
 *  2. a `locationRef` and a `workspaceRef` can never be mistaken for one
 *     another, in either direction;
 *  3. `WORKSPACE_REFERENCE_DOMAIN` and the workspace golden vectors are
 *     **byte-identical** -- #108 adds a sibling and changes nothing.
 *
 * The secrets here are literals that exist only in this file.
 */

const SECRET_A = 'unit-test-location-secret-a';
const SECRET_B = 'unit-test-location-secret-b';

const OWNER = '018f4b1a-0000-7000-8000-000000000001';
const OTHER_OWNER = '018f4b1a-0000-7000-8000-000000000002';
const BUSINESS = '018f4b1a-0000-7000-8000-0000000000bb';
const OTHER_BUSINESS = '018f4b1a-0000-7000-8000-0000000000cc';
const LOCATION = '018f4b1a-0000-7000-8000-0000000000d1';
const OTHER_LOCATION = '018f4b1a-0000-7000-8000-0000000000d2';

describe('golden vectors -- a locationRef is a stable construction', () => {
  it('is byte-identical to the pinned HMAC of the length-prefixed input', () => {
    // Spelled out rather than built from the helper: a test that constructs the
    // input the same way the implementation does proves only determinism.
    const expected = createHmac('sha256', SECRET_A)
      .update(`beauclick.location-reference.v1|36:${OWNER}|36:${BUSINESS}|36:${LOCATION}`, 'utf8')
      .digest('base64url');

    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).toBe(expected);
  });

  it('pins the exact MAC input, so the framing itself cannot drift', () => {
    expect(locationReferenceInput(OWNER, BUSINESS, LOCATION)).toBe(
      `beauclick.location-reference.v1|36:${OWNER}|36:${BUSINESS}|36:${LOCATION}`,
    );
  });

  it('pins the domain prefix', () => {
    expect(LOCATION_REFERENCE_DOMAIN).toBe('beauclick.location-reference.v1');
  });
});

describe('format contract', () => {
  it('is exactly 43 base64url characters, with no +, / or =', () => {
    const reference = deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION);

    expect(reference).toHaveLength(LOCATION_REFERENCE_LENGTH);
    expect(LOCATION_REFERENCE_LENGTH).toBe(43);
    expect(reference).toMatch(LOCATION_REFERENCE_PATTERN);
    expect(reference).not.toMatch(/[+/=]/);
    // A digest, not an envelope.
    expect(Buffer.from(reference, 'base64url')).toHaveLength(32);
  });

  it('rejects everything that is not exactly that shape', () => {
    const reference = deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION);
    for (const bad of ['', reference.slice(0, 42), `${reference}x`, `${reference.slice(0, 42)}+`, LOCATION]) {
      expect(LOCATION_REFERENCE_PATTERN.test(bad)).toBe(false);
    }
    expect(LOCATION_REFERENCE_PATTERN.test(reference)).toBe(true);
  });

  it('exposes no raw identity -- not the owner, not the business, not the location', () => {
    const reference = deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION);
    const decoded = Buffer.from(reference, 'base64url').toString('utf8');
    for (const secretish of [OWNER, BUSINESS, LOCATION, SECRET_A]) {
      expect(reference).not.toContain(secretish);
      expect(decoded).not.toContain(secretish);
    }
  });
});

describe('the MAC binds owner, organisation and location together', () => {
  it('is stable for the same triple', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).toBe(
      deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION),
    );
  });

  it('differs for two locations of the same owner and business', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).not.toBe(
      deriveLocationReference(SECRET_A, OWNER, BUSINESS, OTHER_LOCATION),
    );
  });

  it('differs for the same location id quoted under a different business', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).not.toBe(
      deriveLocationReference(SECRET_A, OWNER, OTHER_BUSINESS, LOCATION),
    );
  });

  it('differs for two owners of the same location -- a stolen reference is inert', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).not.toBe(
      deriveLocationReference(SECRET_A, OTHER_OWNER, BUSINESS, LOCATION),
    );
  });

  it('differs under a different secret, so rotation invalidates outstanding references', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).not.toBe(
      deriveLocationReference(SECRET_B, OWNER, BUSINESS, LOCATION),
    );
  });

  it('length-prefixes every field, so two different triples cannot collide', () => {
    // The naive concatenation really does collide, and the real encoding does not.
    expect('aa' + 'b' + 'cc').toBe('a' + 'ab' + 'cc');
    expect(locationReferenceInput('aa', 'b', 'cc')).not.toBe(locationReferenceInput('a', 'ab', 'cc'));
    expect(deriveLocationReference(SECRET_A, 'aa', 'b', 'cc')).not.toBe(deriveLocationReference(SECRET_A, 'a', 'ab', 'cc'));
  });
});

describe('constant-time comparison', () => {
  it('is correct for equal and unequal values', () => {
    expect(locationReferencesMatch('abc', 'abc')).toBe(true);
    expect(locationReferencesMatch('abc', 'abd')).toBe(false);
  });

  it('returns false rather than THROWING on a length mismatch', () => {
    expect(() => locationReferencesMatch('a', 'abcdefghijklmnop')).not.toThrow();
    expect(locationReferencesMatch('a', 'abcdefghijklmnop')).toBe(false);
    expect(locationReferencesMatch('', 'x')).toBe(false);
  });
});

describe('resolveLocationReference', () => {
  const owned = [
    { businessId: BUSINESS, locationId: LOCATION },
    { businessId: BUSINESS, locationId: OTHER_LOCATION },
  ];

  it('returns the location whose recomputed reference matches', () => {
    expect(resolveLocationReference(SECRET_A, OWNER, owned, deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION))).toEqual(
      { businessId: BUSINESS, locationId: LOCATION },
    );
  });

  it('returns null rather than throwing, so `business` owns its own refusal', () => {
    expect(resolveLocationReference(SECRET_A, OWNER, owned, 'not-a-reference')).toBeNull();
    expect(
      resolveLocationReference(SECRET_A, OWNER, owned, deriveLocationReference(SECRET_A, OTHER_OWNER, BUSINESS, LOCATION)),
    ).toBeNull();
  });

  it('refuses a reference for a location the caller no longer owns', () => {
    const valid = deriveLocationReference(SECRET_A, OWNER, BUSINESS, OTHER_LOCATION);
    expect(resolveLocationReference(SECRET_A, OWNER, [{ businessId: BUSINESS, locationId: LOCATION }], valid)).toBeNull();
  });

  it('refuses everything when the caller owns nothing', () => {
    expect(resolveLocationReference(SECRET_A, OWNER, [], deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION))).toBeNull();
  });

  it('compares every owned candidate through the injected seam, and the seam is what decides', () => {
    const compare = jest.fn(locationReferencesMatch);
    const valid = deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION);

    expect(resolveLocationReference(SECRET_A, OWNER, owned, valid, compare)).toEqual({ businessId: BUSINESS, locationId: LOCATION });
    expect(compare).toHaveBeenCalledTimes(owned.length);

    expect(resolveLocationReference(SECRET_A, OWNER, owned, valid, () => false)).toBeNull();
  });

  it('does not reach the comparison at all for a malformed reference', () => {
    const compare = jest.fn(locationReferencesMatch);
    expect(resolveLocationReference(SECRET_A, OWNER, owned, 'rubbish', compare)).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });
});

describe('cross-domain: a locationRef and a workspaceRef can never be confused', () => {
  const businessParty: WorkspaceParty = { partyType: 'business', partyId: BUSINESS };

  it('the same material under the two domains produces different 43-char strings', () => {
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, BUSINESS)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, businessParty),
    );
    expect(deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, { partyType: 'business', partyId: LOCATION }),
    );
  });

  it('the two MAC inputs never share a prefix -- the domain string is field one', () => {
    expect(locationReferenceInput(OWNER, BUSINESS, LOCATION).startsWith(LOCATION_REFERENCE_DOMAIN)).toBe(true);
    expect(workspaceReferenceInput(OWNER, businessParty).startsWith(WORKSPACE_REFERENCE_DOMAIN)).toBe(true);
    expect(LOCATION_REFERENCE_DOMAIN).not.toBe(WORKSPACE_REFERENCE_DOMAIN);
  });

  it('resolveLocationReference rejects a genuine workspaceRef', () => {
    const workspaceRef = deriveWorkspaceReference(SECRET_A, OWNER, businessParty);
    expect(
      resolveLocationReference(SECRET_A, OWNER, [{ businessId: BUSINESS, locationId: LOCATION }], workspaceRef),
    ).toBeNull();
  });

  it('resolveWorkspaceReference rejects a genuine locationRef', () => {
    const locationRef = deriveLocationReference(SECRET_A, OWNER, BUSINESS, LOCATION);
    expect(resolveWorkspaceReference(SECRET_A, OWNER, [businessParty], locationRef)).toBeNull();
  });
});

describe('the workspace primitive is byte-identical -- #108 changed nothing', () => {
  it('WORKSPACE_REFERENCE_DOMAIN is unchanged', () => {
    expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
  });

  it('a workspace reference from the pinned pre-extraction input still resolves', () => {
    // The same fixed vector `workspace-reference.spec.ts` pins, recomputed here
    // so a change to the workspace primitive fails this sibling suite too.
    const owner = '018f4b1a-0000-7000-8000-000000000001';
    const party: WorkspaceParty = { partyType: 'business', partyId: '018f4b1a-0000-7000-8000-0000000000bb' };
    const secret = 'unit-test-workspace-secret-a';
    const expected = createHmac('sha256', secret)
      .update(`beauclick.workspace-reference.v1|36:${owner}|8:business|36:${party.partyId}`, 'utf8')
      .digest('base64url');
    expect(deriveWorkspaceReference(secret, owner, party)).toBe(expected);
  });
});

describe('the library imports no domain and touches no database', () => {
  it('imports only node:crypto', () => {
    const source = readFileSync(join(__dirname, 'location-reference.ts'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    const imports = [...executable.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto']);

    for (const forbidden of ['@beauclick/business', '@beauclick/provider', 'typeorm', '@nestjs/', 'require(', './workspace-reference']) {
      expect(executable).not.toContain(forbidden);
    }

    expect(executable).toContain('export function deriveLocationReference');
    expect(executable.length).toBeGreaterThan(800);
  });
});
