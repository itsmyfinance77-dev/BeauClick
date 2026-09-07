import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * V3.3 Story #108 (`#44b`) -- the structural proof that `business` crosses the
 * city boundary through a PORT, not an import.
 *
 * ADR-049 section 3.2: "`business` imports no `provider` ORM entity; ADR-011's
 * boundary and the `scope:business` -> `scope:shared` lint rule both stand." A
 * reviewer can confirm that today; this spec fails the build on the day a
 * `business` source starts naming `provider`'s tables or entities directly.
 *
 * The lint rule (`@nx/enforce-module-boundaries`) already forbids
 * `import ... from '@beauclick/provider'`. This adds the finer-grained check:
 * no raw `provider.*` SQL, no `CityEntity`, no `locations_cities`, from anywhere
 * in the module's own source.
 */

const SRC = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Whole-line `//` comments and block comments removed -- a docblock may legitimately name what the code must not import. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

interface SourceFile {
  readonly path: string;
  readonly code: string;
}

const businessSources: SourceFile[] = walk(SRC)
  .map((path) => ({ path: relative(SRC, path).split(sep).join('/'), code: stripComments(readFileSync(path, 'utf8')) }))
  .filter((file) => !file.path.endsWith('.spec.ts'));

/** The tokens only `provider` may name -- a `business` source that names any of them has reached across the boundary. */
const PROVIDER_TOKENS = ["'@beauclick/provider'", '"@beauclick/provider"', 'CityEntity', 'locations_cities', 'provider.locations_cities'];

/** A raw query against any `provider.` schema table. */
const PROVIDER_SCHEMA_QUERY = /\bfrom\s+provider\.|\bjoin\s+provider\.|\binto\s+provider\./i;

describe('business does not import or query provider (#108)', () => {
  it('the scan sees the real business module', () => {
    expect(businessSources.length).toBeGreaterThan(15);
    expect(businessSources.map((f) => f.path)).toEqual(expect.arrayContaining(['business-location.service.ts', 'ports.ts']));
  });

  it('no business source imports `@beauclick/provider` or names a provider entity or table', () => {
    const offenders = businessSources
      .map((file) => ({ path: file.path, hits: PROVIDER_TOKENS.filter((token) => file.code.includes(token)) }))
      .filter((entry) => entry.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it('no business source runs a raw query against the provider schema', () => {
    const offenders = businessSources.filter((file) => PROVIDER_SCHEMA_QUERY.test(file.code)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the location service reaches cities only through the LOCATION_CITY_CATALOGUE port', () => {
    const service = businessSources.find((file) => file.path === 'business-location.service.ts');
    expect(service).toBeDefined();
    expect(service!.code).toContain('LOCATION_CITY_CATALOGUE');
    expect(service!.code).toContain('lookupAssignableCity');
    // and nothing that would be a direct city read
    expect(service!.code).not.toMatch(/getRepository\(\s*CityEntity/);
  });

  describe('the scan is non-vacuous -- each forbidden shape is caught when planted', () => {
    it.each([
      ["import { CityEntity } from '@beauclick/provider';", PROVIDER_TOKENS],
      ['const rows = await m.query(`SELECT id FROM provider.locations_cities`);', null],
      ['manager.getRepository(CityEntity).find()', PROVIDER_TOKENS],
    ])('catches %s', (planted, tokens) => {
      const code = stripComments(planted as string);
      if (tokens) {
        expect((tokens as string[]).some((t) => code.includes(t))).toBe(true);
      } else {
        expect(PROVIDER_SCHEMA_QUERY.test(code)).toBe(true);
      }
    });

    it('does NOT flag an innocent business query against its own schema', () => {
      const code = stripComments('await m.query(`SELECT id FROM business.locations WHERE business_id = $1`);');
      expect(PROVIDER_SCHEMA_QUERY.test(code)).toBe(false);
      expect(PROVIDER_TOKENS.some((t) => code.includes(t))).toBe(false);
    });
  });
});
