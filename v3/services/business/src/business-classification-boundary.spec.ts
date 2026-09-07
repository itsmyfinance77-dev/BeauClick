import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { BUSINESS_VERTICALS } from './entities/business-vertical.entity';
import { BUSINESS_TRAITS } from './entities/business-trait.entity';

/**
 * V3.3 Story #107 (`#44a`) -- the structural proof that classification
 * AUTHORIZES NOTHING.
 *
 * `V33-DEC-030` D1 and `V33-DEC-032` R7 both require this to be proved
 * structurally rather than asserted by review, and ADR-049 section 1.7 records
 * why: a reviewer can only confirm that no authorization path reads these tables
 * *today*, while this spec fails the build on the day one starts to.
 *
 * ## How it decides what an "authorization path" is
 *
 * Not by a hand-written list, which is the stale-list failure ADR-027 exists to
 * eliminate. A file is in scope if EITHER its path names it as one (`guard`,
 * `resolver`, `ownership`, `capability`, `verifier`, `authoriz*`, `eligib*`,
 * `entitlement`, `ports`) OR its CONTENT declares one (`CanActivate`,
 * `OwnerResolver`, `hasCapability`, `PRIVILEGED_CAPABILITIES`,
 * `@ResolveOwner`, `@RequireCapability`). So a new guard written tomorrow in a
 * file nobody thought to add is in scope on the day it is written.
 *
 * ## Non-vacuity
 *
 * Every rule below is also run against PLANTED in-memory fixtures -- one per
 * forbidden dependency shape -- and each planted fixture must be caught. A
 * scanner that found nothing because it was looking in an empty set, or for a
 * pattern that can no longer match, fails those cases first.
 */

const V3_ROOT = resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['libs', 'services', 'apps/api/src', 'packages'];

/** The identifiers only #107's own module may name. */
const CLASSIFICATION_TOKENS = [
  'business_verticals',
  'business_traits',
  'BusinessVerticalEntity',
  'BusinessTraitEntity',
  'BusinessClassificationService',
  'ReplaceBusinessClassificationDto',
  'BUSINESS_VERTICALS',
  'BUSINESS_TRAITS',
];

/** The vocabulary values themselves, as source literals. */
const VOCABULARY_LITERALS = [...BUSINESS_VERTICALS, ...BUSINESS_TRAITS].flatMap((value) => [`'${value}'`, `"${value}"`]);

/**
 * The files that legitimately own classification, by design. Everything else in
 * the platform must be free of it.
 *
 * Deliberately a short, explicit list rather than a directory prefix: a new
 * business-module file that starts naming these tables has to be added here on
 * purpose, which is the review moment this spec exists to create.
 */
const CLASSIFICATION_OWNERS = [
  'services/business/src/entities/business-vertical.entity.ts',
  'services/business/src/entities/business-trait.entity.ts',
  'services/business/src/business-classification.service.ts',
  'services/business/src/business-classification.audit.ts',
  'services/business/src/dto/business-classification.dto.ts',
  'services/business/src/business.controller.ts',
  'services/business/src/business.module.ts',
  'services/business/src/business-subject-data.contract.ts',
  'services/business/src/index.ts',
];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Comments are not code and cannot read a table, so they are removed before any
 * scan -- otherwise a docblock that truthfully says "this file must never read
 * `business_verticals`" would be indistinguishable from one that does.
 *
 * Deliberately conservative: block comments, and only WHOLE lines that begin
 * with `//` or `*`. A trailing `//` is left alone rather than risking a
 * truncation that could hide real code -- a scanner that removes too much is
 * exactly the vacuous check these assertions exist to prevent.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

function walk(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.nx', 'coverage', '.next'].includes(entry.name)) return [];
      return walk(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function loadPlatformSources(): SourceFile[] {
  return SCAN_ROOTS.flatMap((root) => walk(join(V3_ROOT, root)))
    .map((path) => ({ path: relative(V3_ROOT, path).split(sep).join('/'), text: stripComments(readFileSync(path, 'utf8')) }))
    .filter((file) => !file.path.endsWith('.spec.ts') && !file.path.includes('/test/'));
}

/** Pure, so the same rule runs over the real tree and over planted fixtures. */
function isAuthorizationPath(file: SourceFile): boolean {
  const byName = /(guard|resolver|ownership|capabilit|verifier|authoriz|eligib|entitlement|ports)/i.test(file.path);
  const byContent =
    /CanActivate|OwnerResolver|hasCapability|PRIVILEGED_CAPABILITIES|@ResolveOwner|@RequireCapability/.test(file.text);
  return byName || byContent;
}

function findTokens(file: SourceFile, tokens: readonly string[]): string[] {
  return tokens.filter((token) => file.text.includes(token));
}

const platform = loadPlatformSources();
/**
 * Authorization paths, EXCLUDING classification's own module files.
 *
 * `business.controller.ts` and `business.module.ts` name the classification
 * service because they mount it, and the controller declares `@ResolveOwner` on
 * its classification routes -- that is the ownership guard PROTECTING
 * classification, not classification granting authority. The resolvers
 * themselves (`business-membership.resolver.ts`), every guard, every capability
 * port and every other domain stay fully in scope, which is where a real
 * violation would live.
 */
const authorizationPaths = platform
  .filter((file) => !CLASSIFICATION_OWNERS.includes(file.path))
  .filter(isAuthorizationPath);

describe('classification authorizes nothing (#107)', () => {
  it('the scan sees a REAL platform, not an empty set', () => {
    // The guard against a check that silently passes. An empty file set produces
    // zero violations and reads exactly like a clean platform.
    expect(platform.length).toBeGreaterThan(200);
    expect(authorizationPaths.length).toBeGreaterThan(10);

    const paths = authorizationPaths.map((file) => file.path);
    expect(paths).toContain('libs/ownership/src/ownership.guard.ts');
    expect(paths).toContain('libs/auth/src/capability.guard.ts');
    expect(paths).toContain('libs/auth/src/privileged-capability.port.ts');
    expect(paths).toContain('services/business/src/business-membership.resolver.ts');
  });

  it('NO authorization function, guard, resolver, verifier or port names either table', () => {
    const offenders = authorizationPaths
      .map((file) => ({ path: file.path, hits: findTokens(file, CLASSIFICATION_TOKENS) }))
      .filter((entry) => entry.hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it('NO authorization path compares against a vertical or trait VALUE', () => {
    const offenders = authorizationPaths
      .map((file) => ({ path: file.path, hits: findTokens(file, VOCABULARY_LITERALS) }))
      .filter((entry) => entry.hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it('outside the business module, nothing in the platform names either table at all', () => {
    // Wider than the authorization subset on purpose: finance, booking, chat,
    // search, commerce and commercial-policy decision paths are all covered by
    // this, whatever their filenames happen to look like.
    const offenders = platform
      .filter((file) => !CLASSIFICATION_OWNERS.includes(file.path))
      .map((file) => ({ path: file.path, hits: findTokens(file, CLASSIFICATION_TOKENS) }))
      .filter((entry) => entry.hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it('every declared owner file exists and is really in the scan', () => {
    // Stops the allowlist from silently protecting a path that no longer exists,
    // which would let a renamed file quietly leave the exemption behind.
    const scanned = new Set(platform.map((file) => file.path));
    for (const owner of CLASSIFICATION_OWNERS) {
      expect(scanned.has(owner)).toBe(true);
    }
  });

  describe('the scan is non-vacuous -- every forbidden shape is caught when planted', () => {
    const planted: ReadonlyArray<{ name: string; file: SourceFile }> = [
      {
        name: 'a guard importing the vertical entity',
        file: {
          path: 'libs/auth/src/planted.guard.ts',
          text: `import { BusinessVerticalEntity } from '@beauclick/business';\nexport class X implements CanActivate {}`,
        },
      },
      {
        name: 'a resolver querying the traits table',
        file: {
          path: 'services/business/src/planted.resolver.ts',
          text: `export class X { run() { return this.db.query('SELECT 1 FROM business.business_traits'); } }`,
        },
      },
      {
        name: 'a capability verifier branching on a vertical value',
        file: {
          path: 'libs/auth/src/planted-capability.port.ts',
          text: `export function hasCapability(v: string) { return v === 'clinic'; }`,
        },
      },
      {
        name: 'an entitlement decision injecting the classification service',
        file: {
          path: 'services/commercial-policy/src/planted-entitlement.ts',
          text: `import { BusinessClassificationService } from '@beauclick/business';\nexport class X {}`,
        },
      },
      {
        name: 'an ownership port reading the vocabulary constant',
        file: {
          path: 'services/business/src/planted-ports.ts',
          text: `import { BUSINESS_TRAITS } from './entities/business-trait.entity';\nexport const x = BUSINESS_TRAITS;`,
        },
      },
      {
        name: 'a booking eligibility check comparing a trait value',
        file: {
          path: 'services/booking/src/planted-eligibility.ts',
          text: `export const allowed = (t: string) => t === 'multi_location';`,
        },
      },
    ];

    it.each(planted.map((entry) => [entry.name, entry.file] as const))(
      'catches %s',
      (_name, file) => {
        expect(isAuthorizationPath(file)).toBe(true);
        const hits = [...findTokens(file, CLASSIFICATION_TOKENS), ...findTokens(file, VOCABULARY_LITERALS)];
        expect(hits.length).toBeGreaterThan(0);
      },
    );

    it('does NOT flag an ordinary authorization file that mentions neither', () => {
      // The other half of non-vacuity: a scanner that flagged everything would
      // pass every case above while proving nothing.
      const innocent: SourceFile = {
        path: 'libs/ownership/src/innocent.guard.ts',
        text: `export class X implements CanActivate { canActivate() { return true; } }`,
      };
      expect(isAuthorizationPath(innocent)).toBe(true);
      expect([...findTokens(innocent, CLASSIFICATION_TOKENS), ...findTokens(innocent, VOCABULARY_LITERALS)]).toEqual([]);
    });
  });
});

describe('`clinic` is a commercial label and nothing more (#107)', () => {
  /**
   * `V33-DEC-030` D1 and `V33-DEC-032` R7. The behavioural half -- that a
   * `clinic` owner and a `salon` owner get byte-identical authorization
   * outcomes on every route -- is proved end to end in
   * `apps/api/test/business-classification.pg-spec.ts`. What this asserts is the
   * structural half: no source in the platform treats the two differently, and
   * no medical vocabulary entered the codebase with them.
   */
  const MEDICAL_TOKENS = [
    'diagnos',
    'treatment_plan',
    'contraindicat',
    'medication',
    'allergy',
    'allergies',
    'skin_condition',
    'medical_record',
    'medicalRecord',
    'patient',
    'prescription',
    'before_after',
    'clinical',
  ];

  const businessSources = platform.filter((file) => file.path.startsWith('services/business/src/'));

  it('the business module introduces no medical, diagnostic or clinical vocabulary', () => {
    expect(businessSources.length).toBeGreaterThan(5);

    const offenders = businessSources
      .map((file) => ({
        path: file.path,
        hits: MEDICAL_TOKENS.filter((token) => file.text.toLowerCase().includes(token.toLowerCase())),
      }))
      .filter((entry) => entry.hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it('the medical scan is non-vacuous', () => {
    const plantedTable: SourceFile = {
      path: 'services/business/src/planted-medical.entity.ts',
      text: `@Entity({ name: 'patient_records' }) export class X { diagnosis!: string; }`,
    };
    const hits = MEDICAL_TOKENS.filter((token) => plantedTable.text.toLowerCase().includes(token.toLowerCase()));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('no source treats `clinic` differently from any other vertical', () => {
    // A comparison against the literal `'clinic'` anywhere outside the closed
    // vocabulary declaration itself is the shape a special case would take.
    const offenders = platform
      .filter((file) => file.path !== 'services/business/src/entities/business-vertical.entity.ts')
      .filter((file) => /['"]clinic['"]/.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
