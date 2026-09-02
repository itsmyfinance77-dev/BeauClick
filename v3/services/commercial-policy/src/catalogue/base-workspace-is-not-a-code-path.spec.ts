import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `D-7` is a ROW, and this file is what makes that claim checkable.
 *
 * `V33-DEC-009` ratifies the base workspace as an automatically assigned,
 * published, zero-price plan version so every seller has one EXPLICIT
 * subscription history rather than an implicit fallback. Issue #40 adds the
 * requirement that matters more than the row itself: *do not turn `D-7` into a
 * hidden code fallback.*
 *
 * A hidden fallback is not a thing you can see in a diff — it is a constant in
 * one file and a `?? BASE_PLAN` three files away. So this suite asserts the
 * structural property instead: **the literal `D-7` appears in no production
 * source in the workspace.** The catalogue answers "which version is
 * auto-assignable at this instant?" and the code never knows the key
 * (ADR-041 §6).
 *
 * The migration that seeds the row is scanned too, for the opposite reason: it
 * MUST contain the literal, and that is this suite's non-vacuity control. A
 * scanner that found nothing anywhere would pass the absence test while proving
 * nothing at all.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const PRODUCTION_SOURCE_ROOTS = ['services', 'libs', 'packages', 'apps/api/src'];

/** The ratified base-workspace key, and the schedule key the seed pairs with it. */
const BASE_WORKSPACE_KEY = 'D-7';

const MIGRATION_DIR = 'database/migrations/commercial';

/**
 * Strips comments and NOTHING else.
 *
 * String literals are deliberately KEPT: `if (key === 'D-7')` is exactly the
 * fallback this suite exists to forbid, and stripping strings would make the
 * check blind to the only form the offence can take. Documentation that names
 * the ratified key -- as several files below legitimately do, including the
 * ADR reference in this module's own docblocks -- is prose, not a code path.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
}

function productionSources(): Array<{ file: string; source: string }> {
  const collected: Array<{ file: string; source: string }> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // Specs are excluded: this suite and the real-PostgreSQL ones name the
      // key on purpose, to assert the seeded row's properties.
      if (entry.name.endsWith('.spec.ts')) continue;
      collected.push({
        file: path.slice(WORKSPACE_ROOT.length + 1),
        source: stripComments(readFileSync(path, 'utf8')),
      });
    }
  };

  for (const root of PRODUCTION_SOURCE_ROOTS) walk(resolve(WORKSPACE_ROOT, root));
  return collected;
}

function commercialMigrationSql(): string {
  const directory = resolve(WORKSPACE_ROOT, MIGRATION_DIR);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n');
}

describe('the base workspace is a row, not a code path', () => {
  const sources = productionSources();

  it('scans a real, substantial body of production source', () => {
    // The discovery half. An absence assertion over an empty list is the
    // failure mode this check exists to avoid, so the universe is measured
    // before it is searched.
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('commercial-catalogue.service.ts'),
        expect.stringContaining('app.module.ts'),
      ]),
    );
  });

  it('names `D-7` in no production TypeScript file anywhere in the workspace', () => {
    const offenders = sources
      .filter(({ source }) => source.includes(BASE_WORKSPACE_KEY))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('names no base-plan constant under any other spelling either', () => {
    // The key could be hidden behind a name rather than behind the string. This
    // is narrower than a general grep and deliberately so: it looks for an
    // identifier that would BE the fallback.
    const fallbackShaped = /\b(BASE_PLAN|BASE_WORKSPACE|DEFAULT_PLAN|FALLBACK_PLAN)[A-Z_]*\s*=/;
    const offenders = sources.filter(({ source }) => fallbackShaped.test(source)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('would CATCH a planted fallback, in either of the two forms one can take', () => {
    // Non-vacuity, through the same predicate the real assertion uses. A
    // detector blinded by comment-stripping would pass the test above while a
    // literal comparison sat in the source.
    const plantedLiteral = stripComments("if (planKey === 'D-7') return baseWorkspace;");
    const plantedConstant = stripComments("const BASE_PLAN_KEY = 'D-7';");
    expect(plantedLiteral.includes(BASE_WORKSPACE_KEY)).toBe(true);
    expect(plantedConstant.includes(BASE_WORKSPACE_KEY)).toBe(true);

    // And a documentation mention is correctly NOT a finding.
    const documented = stripComments(['/** The base workspace is `D-7` (V33-DEC-009). */', 'const x = 1;'].join('\n'));
    expect(documented.includes(BASE_WORKSPACE_KEY)).toBe(false);
  });

  it('resolves the base workspace by a row property, so the absence above means something', () => {
    const service = sources.find(({ file }) => file.endsWith('commercial-catalogue.service.ts'));
    expect(service).toBeDefined();
    // The mechanism that replaces the constant. If this method disappeared, the
    // absence test above would still pass while nothing resolved the base
    // workspace at all -- which is why the positive is asserted next to it.
    expect(service?.source).toContain('resolveAutoAssignablePlanVersion');
    expect(service?.source).toContain('auto_assignable = true');
  });
});

describe('the migration seeds `D-7` exactly as `V33-DEC-009` ratifies it', () => {
  const sql = commercialMigrationSql();

  it('contains the literal, which is this suite\'s non-vacuity control', () => {
    // If the scanner above could not find `D-7` anywhere, its empty result
    // would prove nothing. It finds it here, in the one place it belongs.
    expect(sql).toContain(`'${BASE_WORKSPACE_KEY}'`);
  });

  it('seeds it with zero entitlements and an empty capability set', () => {
    // The absence of an allowance, never a choice of one. #46 still owns the
    // base-workspace definition, and closing it will publish a NEW version.
    const planInsert = /INSERT INTO commercial\.plan_versions[\s\S]*?;/.exec(sql)?.[0] ?? '';
    expect(planInsert).toContain("'D-7', 1, 'D-7'");
    expect(planInsert).toContain("0, 0, 0, '{}'");
    // NULL rather than 0: the base workspace has no recurring term, and zero
    // would read as "renews immediately".
    expect(planInsert).toContain('NULL');
    expect(planInsert).toContain('true');
  });

  it('prices it with exactly one ZERO tier, which is how a flat price is represented', () => {
    const tierInsert = /INSERT INTO commercial\.price_tiers[\s\S]*?;/.exec(sql)?.[0] ?? '';
    expect(tierInsert).toContain('1, 1, 0');
    // One tier statement, not two.
    expect(sql.match(/INSERT INTO commercial\.price_tiers/g)).toHaveLength(1);
  });

  it('inserts it as a DRAFT and publishes it by transition, so every publication check runs', () => {
    // A row born published would skip the publication trigger -- the tier
    // completeness check, the published-schedule requirement, and the
    // auto-assignable zero-price check. The seed therefore travels the same
    // path an administrator does.
    expect(sql).toMatch(/UPDATE commercial\.plan_versions\s+SET lifecycle_state = 'published'/);
    expect(sql).toMatch(/UPDATE commercial\.price_schedule_versions\s+SET lifecycle_state = 'published'/);
    const planInsert = /INSERT INTO commercial\.plan_versions[\s\S]*?;/.exec(sql)?.[0] ?? '';
    expect(planInsert).not.toContain('published');
  });

  it('attributes the seed to a LABEL, because no administrator exists at migration time', () => {
    expect(sql).toContain("'migration:v3.3-a'");
    // And never to an invented user id.
    expect(sql).not.toMatch(/published_by_user_id\s*\)/);
  });
});
