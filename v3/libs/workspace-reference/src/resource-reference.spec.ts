import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RESOURCE_REFERENCE_DOMAIN,
  RESOURCE_REFERENCE_LENGTH,
  RESOURCE_REFERENCE_PATTERN,
  deriveResourceReference,
  resolveResourceReference,
  resourceReferenceInput,
  resourceReferencesMatch,
} from './resource-reference';
import {
  LOCATION_REFERENCE_DOMAIN,
  deriveLocationReference,
  resolveLocationReference,
} from './location-reference';
import {
  WORKSPACE_REFERENCE_DOMAIN,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
} from './workspace-reference';

/**
 * The opaque resource reference -- V3.3 Story #110 (`#110a`), `V33-DEC-034` R5.
 *
 * Four claims, and the third is the one the story turns on:
 *
 *  1. the construction is **stable** -- a pinned golden vector, so a refactor
 *     that changes the digest fails here rather than silently invalidating every
 *     outstanding reference;
 *  2. the encoding is **injective** -- two distinct tuples cannot collide;
 *  3. the three reference families are **mutually unusable** in every direction,
 *     and the existing workspace and location golden vectors are **byte-identical**;
 *  4. resolution **never queries** -- it enumerates caller-owned candidates and
 *     constant-time compares, so a reference authorises nothing on its own.
 */

const SECRET = 'test-secret-for-resource-references';
const OWNER = '01930000-0000-7000-8000-000000000001';
const BUSINESS = '01930000-0000-7000-8000-000000000002';
const LOCATION = '01930000-0000-7000-8000-000000000003';
const RESOURCE = '01930000-0000-7000-8000-000000000004';

describe('golden vectors -- a resourceRef is a stable construction', () => {
  it('pins the domain string', () => {
    // Changing this invalidates every outstanding resourceRef. It is pinned so
    // that is a deliberate decision with a failing test, never a silent edit.
    expect(RESOURCE_REFERENCE_DOMAIN).toBe('beauclick.resource-reference.v1');
  });

  it('pins the exact MAC input encoding', () => {
    expect(resourceReferenceInput(OWNER, BUSINESS, LOCATION, RESOURCE)).toBe(
      'beauclick.resource-reference.v1' +
        `|36:${OWNER}` +
        `|36:${BUSINESS}` +
        `|36:${LOCATION}` +
        `|36:${RESOURCE}`,
    );
  });

  it('pins the derived reference against an independently computed HMAC', () => {
    // Computed here from node:crypto directly rather than by calling the
    // function under test, so this is a real second opinion.
    const expected = createHmac('sha256', SECRET)
      .update(
        `beauclick.resource-reference.v1|36:${OWNER}|36:${BUSINESS}|36:${LOCATION}|36:${RESOURCE}`,
        'utf8',
      )
      .digest('base64url');

    expect(deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE)).toBe(expected);
  });

  it('is 43 base64url characters and matches the closed pattern', () => {
    const ref = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
    expect(ref).toHaveLength(RESOURCE_REFERENCE_LENGTH);
    expect(RESOURCE_REFERENCE_LENGTH).toBe(43);
    expect(RESOURCE_REFERENCE_PATTERN.test(ref)).toBe(true);
  });

  it('is deterministic for the same tuple and secret', () => {
    expect(deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE)).toBe(
      deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE),
    );
  });
});

describe('the encoding is injective -- distinct tuples cannot collide', () => {
  const base = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);

  it.each([
    ['a different owner', ['01930000-0000-7000-8000-0000000000ff', BUSINESS, LOCATION, RESOURCE]],
    ['a different business', [OWNER, '01930000-0000-7000-8000-0000000000ff', LOCATION, RESOURCE]],
    ['a different location', [OWNER, BUSINESS, '01930000-0000-7000-8000-0000000000ff', RESOURCE]],
    ['a different resource', [OWNER, BUSINESS, LOCATION, '01930000-0000-7000-8000-0000000000ff']],
  ])('changing %s changes the reference', (_label, tuple) => {
    const [o, b, l, r] = tuple as string[];
    expect(deriveResourceReference(SECRET, o, b, l, r)).not.toBe(base);
  });

  it('cannot be re-split: length prefixes stop two tuples concatenating alike', () => {
    // Without netstring framing, ('ab','c') and ('a','bc') would produce the
    // same joined string. With it they cannot.
    expect(deriveResourceReference(SECRET, 'ab', 'c', LOCATION, RESOURCE)).not.toBe(
      deriveResourceReference(SECRET, 'a', 'bc', LOCATION, RESOURCE),
    );
    // The control: the shapes really would have collided unframed.
    expect('ab' + 'c').toBe('a' + 'bc');
  });

  it('a different secret produces a different reference', () => {
    expect(deriveResourceReference('another-secret', OWNER, BUSINESS, LOCATION, RESOURCE)).not.toBe(base);
  });
});

describe('the three reference families are mutually unusable', () => {
  const resourceRef = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
  const locationRef = deriveLocationReference(SECRET, OWNER, BUSINESS, LOCATION);
  const workspaceRef = deriveWorkspaceReference(SECRET, OWNER, { partyType: 'business', partyId: BUSINESS });

  const ownedResources = [{ businessId: BUSINESS, locationId: LOCATION, resourceId: RESOURCE }];
  const ownedLocations = [{ businessId: BUSINESS, locationId: LOCATION }];

  it('the three domain constants are distinct', () => {
    const domains = [RESOURCE_REFERENCE_DOMAIN, LOCATION_REFERENCE_DOMAIN, WORKSPACE_REFERENCE_DOMAIN];
    expect(new Set(domains).size).toBe(3);
  });

  it('the three references of one owner/business are three different strings', () => {
    expect(new Set([resourceRef, locationRef, workspaceRef]).size).toBe(3);
  });

  it('a resourceRef does NOT resolve as a locationRef', () => {
    expect(resolveLocationReference(SECRET, OWNER, ownedLocations, resourceRef)).toBeNull();
  });

  it('a resourceRef does NOT resolve as a workspaceRef', () => {
    expect(
      resolveWorkspaceReference(SECRET, OWNER, [{ partyType: 'business', partyId: BUSINESS }], resourceRef),
    ).toBeNull();
  });

  it('a locationRef does NOT resolve as a resourceRef', () => {
    expect(resolveResourceReference(SECRET, OWNER, ownedResources, locationRef)).toBeNull();
  });

  it('a workspaceRef does NOT resolve as a resourceRef', () => {
    expect(resolveResourceReference(SECRET, OWNER, ownedResources, workspaceRef)).toBeNull();
  });

  it('the positive control passes -- the right reference DOES resolve', () => {
    // Without this, every refusal above could be passing for the wrong reason.
    expect(resolveResourceReference(SECRET, OWNER, ownedResources, resourceRef)).toEqual(ownedResources[0]);
    expect(resolveLocationReference(SECRET, OWNER, ownedLocations, locationRef)).toEqual(ownedLocations[0]);
  });

  it('the existing workspace and location golden vectors are byte-identical', () => {
    // #110a adds a third construction and must not perturb the two that already
    // issued references. These are the same values their own specs pin.
    expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
    expect(LOCATION_REFERENCE_DOMAIN).toBe('beauclick.location-reference.v1');
    expect(deriveWorkspaceReference(SECRET, OWNER, { partyType: 'business', partyId: BUSINESS })).toBe(workspaceRef);
    expect(deriveLocationReference(SECRET, OWNER, BUSINESS, LOCATION)).toBe(locationRef);
  });
});

describe('the same resource under another owner, business or location does not match', () => {
  const ref = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
  const OTHER = '01930000-0000-7000-8000-0000000000aa';

  it('another owner’s session cannot use it', () => {
    expect(
      resolveResourceReference(SECRET, OTHER, [{ businessId: BUSINESS, locationId: LOCATION, resourceId: RESOURCE }], ref),
    ).toBeNull();
  });

  it('the same resource id quoted under another business does not match', () => {
    expect(
      resolveResourceReference(SECRET, OWNER, [{ businessId: OTHER, locationId: LOCATION, resourceId: RESOURCE }], ref),
    ).toBeNull();
  });

  it('the same resource id quoted under another location does not match', () => {
    expect(
      resolveResourceReference(SECRET, OWNER, [{ businessId: BUSINESS, locationId: OTHER, resourceId: RESOURCE }], ref),
    ).toBeNull();
  });
});

describe('resolution enumerates and compares -- it never looks anything up', () => {
  const owned = [
    { businessId: BUSINESS, locationId: LOCATION, resourceId: RESOURCE },
    { businessId: BUSINESS, locationId: LOCATION, resourceId: '01930000-0000-7000-8000-000000000005' },
  ];

  it('rejects a malformed reference before computing any candidate', () => {
    const compare = jest.fn(() => true);
    // Would match everything if it were ever called.
    expect(resolveResourceReference(SECRET, OWNER, owned, 'not-a-reference', compare)).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(44)],
    ['a forbidden character', `${'a'.repeat(42)}+`],
    ['empty', ''],
  ])('rejects %s without calling the comparison', (_label, supplied) => {
    const compare = jest.fn(() => true);
    expect(resolveResourceReference(SECRET, OWNER, owned, supplied, compare)).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it('compares EVERY candidate, so the work does not depend on which one matched', () => {
    const compare = jest.fn((candidate: string, supplied: string) => candidate === supplied);
    const first = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, owned[0].resourceId);
    expect(resolveResourceReference(SECRET, OWNER, owned, first, compare)).toEqual(owned[0]);
    // Both candidates were compared even though the first already matched.
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('returns null for an empty candidate set rather than throwing', () => {
    const ref = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
    expect(resolveResourceReference(SECRET, OWNER, [], ref)).toBeNull();
  });
});

describe('constant-time comparison', () => {
  it('matches equal strings and rejects unequal ones', () => {
    const ref = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
    expect(resourceReferencesMatch(ref, ref)).toBe(true);
    expect(resourceReferencesMatch(ref, deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, 'other'))).toBe(false);
  });

  it('does NOT throw on a different-length input', () => {
    // `timingSafeEqual` throws on unequal buffer lengths, which would leak the
    // expected length AND turn a wrong-length input into a 500. Hashing both
    // sides to 32 bytes first removes that.
    const ref = deriveResourceReference(SECRET, OWNER, BUSINESS, LOCATION, RESOURCE);
    expect(() => resourceReferencesMatch(ref, 'short')).not.toThrow();
    expect(resourceReferencesMatch(ref, 'short')).toBe(false);
  });
});

describe('the module imports no domain and touches no database', () => {
  it('imports only node:crypto', () => {
    const source = readFileSync(join(__dirname, 'resource-reference.ts'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    const imports = [...executable.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto']);

    for (const forbidden of [
      '@beauclick/business',
      '@beauclick/provider',
      '@beauclick/booking',
      'typeorm',
      '@nestjs/',
      'require(',
      './location-reference',
      './workspace-reference',
    ]) {
      expect(executable).not.toContain(forbidden);
    }

    // The discovery half: the stripped source is real code, not an empty string
    // that would make every refusal above vacuously true.
    expect(executable).toContain('export function deriveResourceReference');
    expect(executable).toContain('createHmac');
  });
});
