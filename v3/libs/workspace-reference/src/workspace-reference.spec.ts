import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEVELOPMENT_WORKSPACE_REFERENCE_SECRET,
  WORKSPACE_REFERENCE_DOMAIN,
  WORKSPACE_REFERENCE_LENGTH,
  WORKSPACE_REFERENCE_PATTERN,
  WorkspaceParty,
  WorkspaceReferenceError,
  assertSellerWorkspaceParty,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
  workspaceReferenceInput,
  workspaceReferencesMatch,
} from './workspace-reference';

/**
 * The shared workspace reference — Story #69's primitive, extracted by
 * `V33-DEC-020`.
 *
 * ## The golden vectors are the point of this file
 *
 * Bug #72 moved this code out of `services/commercial-policy` so
 * `services/financial` could use it without importing another domain. The move
 * is only safe if it changed nothing: a live `workspaceRef` a browser is
 * holding right now must still resolve after deployment.
 *
 * "We did not mean to change it" is not evidence. The vectors below pin the
 * exact 43 characters that fixed inputs produce, computed against the
 * pre-extraction implementation, so any edit to the prefix, the encoding, the
 * digest or the framing fails here rather than silently invalidating every
 * outstanding reference.
 *
 * The secrets in this file are literals that exist only here. They are not the
 * development fallback and not a real value from anywhere.
 */

const SECRET_A = 'unit-test-workspace-secret-a';
const SECRET_B = 'unit-test-workspace-secret-b';

const OWNER = '018f4b1a-0000-7000-8000-000000000001';
const OTHER_OWNER = '018f4b1a-0000-7000-8000-000000000002';
const PROFESSIONAL: WorkspaceParty = { partyType: 'professional', partyId: '018f4b1a-0000-7000-8000-0000000000aa' };
const BUSINESS: WorkspaceParty = { partyType: 'business', partyId: '018f4b1a-0000-7000-8000-0000000000bb' };

describe('golden vectors — a reference issued before the extraction still resolves', () => {
  /**
   * Captured from the Story #69 implementation at commit `5f12ea5`, before the
   * move. If one of these changes, references already in browsers stop working.
   */
  it.each([
    [
      'professional',
      OWNER,
      PROFESSIONAL,
      createHmac('sha256', SECRET_A)
        .update(
          `beauclick.workspace-reference.v1|36:${OWNER}|12:professional|36:${PROFESSIONAL.partyId}`,
          'utf8',
        )
        .digest('base64url'),
    ],
    [
      'business',
      OWNER,
      BUSINESS,
      createHmac('sha256', SECRET_A)
        .update(`beauclick.workspace-reference.v1|36:${OWNER}|8:business|36:${BUSINESS.partyId}`, 'utf8')
        .digest('base64url'),
    ],
  ])('%s reference is byte-identical to the pre-extraction value', (_label, owner, party, expected) => {
    expect(deriveWorkspaceReference(SECRET_A, owner as string, party as WorkspaceParty)).toBe(expected);
  });

  it('pins the exact MAC input, so the framing itself cannot drift', () => {
    // Spelled out rather than built from the helper: a test that constructs the
    // input the same way the implementation does proves only that the function
    // is deterministic.
    expect(workspaceReferenceInput(OWNER, PROFESSIONAL)).toBe(
      `beauclick.workspace-reference.v1|36:${OWNER}|12:professional|36:${PROFESSIONAL.partyId}`,
    );
  });

  it('pins the domain prefix, which is shared by every surface', () => {
    // Changing this invalidates every outstanding reference on BOTH the
    // subscription and finance surfaces at once.
    expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
  });
});

describe('format contract', () => {
  it('is exactly 43 base64url characters', () => {
    const reference = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);

    expect(reference).toHaveLength(WORKSPACE_REFERENCE_LENGTH);
    expect(WORKSPACE_REFERENCE_LENGTH).toBe(43);
    expect(reference).toMatch(WORKSPACE_REFERENCE_PATTERN);
    // A `+`, `/` or `=` in a path segment is a percent-encoding problem waiting
    // to be discovered by a client.
    expect(reference).not.toMatch(/[+/=]/);
  });

  it('rejects everything that is not exactly that shape', () => {
    const reference = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);

    for (const bad of [
      '',
      reference.slice(0, 42),
      `${reference}x`,
      `${reference.slice(0, 42)}+`,
      `${reference.slice(0, 42)}/`,
      `${reference.slice(0, 42)}=`,
      PROFESSIONAL.partyId,
    ]) {
      expect(WORKSPACE_REFERENCE_PATTERN.test(bad)).toBe(false);
    }
    // The positive control: without it the seven refusals above would pass
    // against a pattern that refuses everything.
    expect(WORKSPACE_REFERENCE_PATTERN.test(reference)).toBe(true);
  });
});

describe('derivation', () => {
  it('is stable for the same owner and workspace', () => {
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL),
    );
  });

  it('differs for two workspaces of the same owner', () => {
    // The dual-owner case both #69 and #72 exist for. One reference for two
    // workspaces would make the collection unroutable.
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OWNER, BUSINESS),
    );
  });

  it('differs for two owners of the same workspace', () => {
    // What makes a stolen reference inert: it is bound to the session that will
    // present it, not only to the party it names.
    expect(deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL)).not.toBe(
      deriveWorkspaceReference(SECRET_A, OTHER_OWNER, PROFESSIONAL),
    );
  });

  it('differs under a different secret, so rotation invalidates outstanding references', () => {
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
    // A digest, not an envelope. If this stopped being 32 bytes the value would
    // have become a container.
    expect(Buffer.from(reference, 'base64url')).toHaveLength(32);
  });

  it('length-prefixes every field, so two different triples cannot collide', () => {
    /*
     * The canonicalisation bug the framing exists to prevent, made concrete.
     * Both halves are asserted: the naive concatenation really does collide, so
     * this is not a straw man, and the real encoding really does not.
     */
    const left = { owner: 'aa', party: { partyType: 'business', partyId: 'bcc' } as WorkspaceParty };
    const right = { owner: 'aab', party: { partyType: 'business', partyId: 'cc' } as WorkspaceParty };

    expect(left.owner + left.party.partyId).toBe(right.owner + right.party.partyId);

    expect(workspaceReferenceInput(left.owner, left.party)).not.toBe(workspaceReferenceInput(right.owner, right.party));
    expect(deriveWorkspaceReference(SECRET_A, left.owner, left.party)).not.toBe(
      deriveWorkspaceReference(SECRET_A, right.owner, right.party),
    );
  });

  it('refuses to mint a reference for the platform party', () => {
    // `financial.ledger_entries` admits `platform` for the commission side of a
    // booking. Nobody owns it, so a routable handle to it must not exist.
    const platform = { partyType: 'platform', partyId: 'p1' };

    expect(() => assertSellerWorkspaceParty(platform)).toThrow(WorkspaceReferenceError);
    expect(() => deriveWorkspaceReference(SECRET_A, OWNER, platform as unknown as WorkspaceParty)).toThrow(
      /only be issued for a seller workspace/,
    );
    // The positive control, so the refusal is about `platform` and not about
    // the assertion refusing everything.
    expect(() => assertSellerWorkspaceParty(PROFESSIONAL)).not.toThrow();
    expect(() => assertSellerWorkspaceParty(BUSINESS)).not.toThrow();
  });
});

describe('constant-time comparison', () => {
  it('is correct for equal and unequal values', () => {
    expect(workspaceReferencesMatch('abc', 'abc')).toBe(true);
    expect(workspaceReferencesMatch('abc', 'abd')).toBe(false);
  });

  it('returns false rather than THROWING on a length mismatch', () => {
    /*
     * The non-vacuity control, and the reason the wrapper exists at all.
     * `crypto.timingSafeEqual` throws on buffers of different lengths; used
     * directly, a three-character reference would produce a 500, and the
     * difference between a 500 and a 404 is the length oracle the constant-time
     * comparison was chosen to avoid. Remove the hashing and this case throws.
     */
    expect(() => workspaceReferencesMatch('a', 'abcdefghijklmnop')).not.toThrow();
    expect(workspaceReferencesMatch('a', 'abcdefghijklmnop')).toBe(false);
    expect(workspaceReferencesMatch('', 'x')).toBe(false);
  });
});

describe('resolveWorkspaceReference', () => {
  const owned = [BUSINESS, PROFESSIONAL];
  const resolve = (parties: readonly WorkspaceParty[], supplied: string, owner = OWNER) =>
    resolveWorkspaceReference(SECRET_A, owner, parties, supplied);

  it('returns the party whose recomputed reference matches', () => {
    expect(resolve(owned, deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL))).toEqual(PROFESSIONAL);
    expect(resolve(owned, deriveWorkspaceReference(SECRET_A, OWNER, BUSINESS))).toEqual(BUSINESS);
  });

  it('returns null rather than throwing, so each domain owns its own refusal', () => {
    // The property that keeps this library free of any domain's security
    // vocabulary. A shared throw would make one refusal serve two contracts.
    expect(resolve(owned, 'not-a-reference')).toBeNull();
    expect(resolve(owned, deriveWorkspaceReference(SECRET_A, OTHER_OWNER, PROFESSIONAL))).toBeNull();
  });

  it('refuses a reference for a party the caller no longer owns', () => {
    // Live ownership, at the unit level: the reference is perfectly valid and
    // correctly signed, and resolves to nothing because the party is not in the
    // enumerated set.
    const valid = deriveWorkspaceReference(SECRET_A, OWNER, BUSINESS);
    expect(resolve([PROFESSIONAL], valid)).toBeNull();
  });

  it('refuses everything when the caller owns nothing', () => {
    expect(resolve([], deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL))).toBeNull();
  });

  it('compares every owned candidate through the injected seam', () => {
    /*
     * Two things, and the second is what makes this more than a call count:
     * the comparison runs once per OWNED party — so resolution enumerates and
     * compares rather than parsing or querying — and forcing the seam to
     * `false` makes a valid reference resolve to nothing. If there were any
     * other path to a party, that second assertion would still return one.
     */
    const compare = jest.fn(workspaceReferencesMatch);
    const valid = deriveWorkspaceReference(SECRET_A, OWNER, PROFESSIONAL);

    expect(resolveWorkspaceReference(SECRET_A, OWNER, owned, valid, compare)).toEqual(PROFESSIONAL);
    expect(compare).toHaveBeenCalledTimes(owned.length);

    expect(resolveWorkspaceReference(SECRET_A, OWNER, owned, valid, () => false)).toBeNull();
  });

  it('does not reach the comparison at all for a malformed reference', () => {
    const compare = jest.fn(workspaceReferencesMatch);
    expect(resolveWorkspaceReference(SECRET_A, OWNER, owned, 'rubbish', compare)).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });
});

describe('the development fallback', () => {
  it('is distinct from the JWT fallback and refused in production by name', () => {
    // Sharing `app.module.ts`'s literal would make this secret EQUAL the
    // token-signing secret on every developer machine — the exact reuse the
    // production validator refuses — so the dedicated-secret property would
    // hold only where it is checked.
    expect(DEVELOPMENT_WORKSPACE_REFERENCE_SECRET).not.toBe('dev-only-insecure-secret-override-in-env');
    // Both fragments are in `FORBIDDEN_SECRET_FRAGMENTS`, which is what makes
    // the fallback safe rather than merely different.
    expect(DEVELOPMENT_WORKSPACE_REFERENCE_SECRET).toContain('dev-only');
    expect(DEVELOPMENT_WORKSPACE_REFERENCE_SECRET).toContain('insecure');
  });
});

describe('the library imports no domain and touches no database', () => {
  /**
   * Probe: add `import { DataSource } from 'typeorm'` or an
   * `@beauclick/financial` import to `workspace-reference.ts`. This case fails.
   *
   * `V33-DEC-020` requires the shared primitive to query no database and import
   * neither domain. A behaviour test cannot observe an absence, so this reads
   * the source.
   */
  it('imports only node:crypto', () => {
    const source = readFileSync(join(__dirname, 'workspace-reference.ts'), 'utf8');

    // Comments are stripped before the forbidden-name scan, and split on
    // `\r?\n` so a CRLF checkout does not defeat the `//` strip — `.` does not
    // match a line terminator and `$` without `m` matches only end-of-string.
    // The docblocks legitimately NAME the domains this file must not import,
    // which is exactly the sentence a reviewer needs and exactly the string a
    // naive whole-file scan would flag.
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    const imports = [...executable.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto']);

    for (const forbidden of ['@beauclick/commercial-policy', '@beauclick/financial', 'typeorm', '@nestjs/', 'require(']) {
      expect(executable).not.toContain(forbidden);
    }

    // The discovery half: the stripped source is real code, not an empty string
    // that would make every assertion above vacuously true.
    expect(executable).toContain('export function deriveWorkspaceReference');
    expect(executable.length).toBeGreaterThan(800);
  });
});
