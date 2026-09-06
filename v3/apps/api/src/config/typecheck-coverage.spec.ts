import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The API typecheck program must contain the whole API test tree.
 *
 * ## The bug this exists to make impossible
 *
 * `api:typecheck` ran `tsc -p apps/api/tsconfig.json --noEmit`, and that config
 * includes only `src/**` + '/' + '*.ts'. So the 57 files under `apps/api/test`
 * — 52 of them `*.pg-spec.ts` — were checked by **nothing**. ts-jest compiled
 * each one for the first time at run time, inside the real-PostgreSQL suite.
 *
 * The consequence is not "a slower signal". It is a signal that arrives after
 * PostgreSQL, OpenSearch and MinIO have been provisioned and roughly 36 minutes
 * of database tests have run, while `pnpm typecheck` — the gate a developer
 * actually waits for — reports success in seconds. V3.3 Story #58 (`#58a`) hit
 * exactly that: a hook rename left one pg spec importing a symbol that no
 * longer existed, every static gate was green, and `error TS2305` surfaced in
 * the middle of a complete database run (bug #97).
 *
 * ## Why this is a test and not just a fixed config
 *
 * The config alone is one glob away from silently regressing. Narrow `include`
 * to `test/**` + '/' + '*.pg-spec.ts' and the two `*.e2e-spec.ts` files fall
 * back out with nothing to notice; point `api:typecheck` at the build config
 * again and the whole tree does. Both are single-token edits that leave every
 * suite green.
 *
 * So this compares the EFFECTIVE program — what TypeScript itself resolves from
 * the config — against the files that are actually on disk, exactly. Not a
 * minimum count, not `toContain`: a set equality, so a test file added tomorrow
 * is covered or this fails.
 *
 * ## Why the config is read through TypeScript and not `JSON.parse`
 *
 * These tsconfigs carry comments, and `tsconfig.typecheck.json` extends another
 * file. `JSON.parse` chokes on the first and cannot see through the second.
 * `ts.readConfigFile` + `ts.parseJsonConfigFileContent` is the same code path
 * `tsc` itself takes, which is the only reading that proves anything about what
 * `tsc` will check.
 *
 * ## The other half: the BUILD program must NOT ship them
 *
 * A test file emitted into `dist/` is a test file in the production image, and
 * `include` is not the emitted set: TypeScript compiles whatever a root file
 * IMPORTS. On master one did — `financial-owner-preflight.spec.ts` imports the
 * real-database harness `test/pg-test-app.factory`, so
 * `dist/apps/api/test/pg-test-app.factory.js` shipped while the build config
 * truthfully said `src` only. Both questions are asked below, because they have
 * different answers.
 */

/** `apps/api`. */
const API_ROOT = resolve(__dirname, '../..');
/** The workspace root, `v3/`. */
const WORKSPACE_ROOT = resolve(API_ROOT, '../..');

const posix = (absolute: string): string => relative(WORKSPACE_ROOT, absolute).split(sep).join('/');

/** The files `tsc -p <config>` would actually check, plus the options it would use. */
function programOf(configPath: string): { files: string[]; options: ts.CompilerOptions } {
  const absolute = resolve(WORKSPACE_ROOT, configPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error) {
    throw new Error(`${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(absolute));
  if (parsed.errors.length > 0) {
    throw new Error(
      `${configPath}: ${parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`,
    );
  }
  return { files: parsed.fileNames.map(posix).sort(), options: parsed.options };
}

/**
 * Every `.ts` file physically under `apps/api/test`.
 *
 * The filesystem rather than `git ls-files`, deliberately: the config's own
 * `include` is a filesystem glob, so comparing like with like is what catches a
 * narrowed glob, and it needs no git process in a CI container. Every tracked
 * file is on disk, so full coverage of this set covers the tracked set too.
 */
function typescriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) found.push(posix(full));
    }
  };
  walk(directory);
  return found.sort();
}

const TYPECHECK_CONFIG = 'apps/api/tsconfig.typecheck.json';
const BUILD_CONFIG = 'apps/api/tsconfig.json';
const TEST_DIR = 'apps/api/test/';

describe('the API typecheck program covers the API test tree', () => {
  const typecheck = programOf(TYPECHECK_CONFIG);
  const build = programOf(BUILD_CONFIG);
  const onDisk = typescriptFilesUnder(join(API_ROOT, 'test'));

  it('found a real, populated test tree to check against', () => {
    /*
     * The discovery half. Two empty sets compare equal, so without this the
     * assertion below would pass just as happily against a walk that found
     * nothing — which is precisely how a coverage test becomes decoration.
     */
    expect(onDisk.length).toBeGreaterThan(40);
    expect(onDisk).toContain('apps/api/test/booking-credit-accounting.pg-spec.ts');
    expect(onDisk).toContain('apps/api/test/pg-test-app.factory.ts');
    // Both suffixes are present, so "covers the tree" is a claim about more
    // than one kind of file.
    expect(onDisk.filter((f) => f.endsWith('.pg-spec.ts')).length).toBeGreaterThan(40);
    expect(onDisk.filter((f) => f.endsWith('.e2e-spec.ts')).length).toBeGreaterThan(0);
  });

  it('checks every one of them — exactly, not approximately', () => {
    const checked = typecheck.files.filter((f) => f.startsWith(TEST_DIR));
    // Set equality in both directions: a file on disk that is not checked fails
    // here, and so does a checked path that no longer exists.
    expect(checked).toEqual(onDisk);
  });

  it('still checks the production source in the same invocation', () => {
    // One target, one program. Splitting src and test across two commands would
    // satisfy the case above and leave `pnpm typecheck` able to pass while the
    // source is broken.
    const source = typecheck.files.filter((f) => f.startsWith('apps/api/src/'));
    expect(source.length).toBeGreaterThan(40);
    expect(source).toContain('apps/api/src/main.ts');
  });

  it('is a checking program, not an emitting one', () => {
    expect(typecheck.options.noEmit).toBe(true);
  });

  it('keeps the production build source-only, by its configured inputs', () => {
    expect(build.files.filter((f) => f.startsWith(TEST_DIR))).toEqual([]);
    expect(build.files.filter((f) => f.endsWith('.spec.ts'))).toEqual([]);
    expect(build.files).toContain('apps/api/src/main.ts');
    expect(build.options.noEmit).toBeFalsy();
  });

  it('and by what it would actually EMIT, which is a different question', () => {
    /*
     * `include` is not the emitted set. TypeScript compiles and emits whatever a
     * root file IMPORTS, whether or not the config mentions it -- so a build
     * whose `include` truthfully says `src` only can still ship a test file.
     *
     * It did. `financial-owner-preflight.spec.ts` imports
     * `../../test/pg-test-app.factory`, and that put a real-database test
     * harness -- `dist/apps/api/test/pg-test-app.factory.js` -- into the
     * production image, on master, invisibly to any assertion about `include`.
     * Excluding the spec roots is what removes it; an `exclude` on `test/**`
     * would not, because exclusion filters the include glob and does not stop
     * transitive emission.
     *
     * So this builds the real program and asks what would land in `dist/`.
     */
    const program = ts.createProgram(
      build.files.map((f) => resolve(WORKSPACE_ROOT, f)),
      build.options,
    );
    const emitted = program
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile)
      .map((f) => posix(f.fileName));

    // Non-vacuity: a program that resolved nothing would satisfy every
    // absence below.
    expect(emitted.length).toBeGreaterThan(100);
    expect(emitted).toContain('apps/api/src/main.ts');

    expect(emitted.filter((f) => f.startsWith(TEST_DIR))).toEqual([]);
    expect(emitted.filter((f) => f.endsWith('.spec.ts'))).toEqual([]);
  });

  it('still type-checks the src specs the build now refuses to ship', () => {
    // The trade has to cut one way only. `tsconfig.json` excludes
    // `**/*.spec.ts` so they are not SHIPPED; `exclude: []` here keeps them
    // CHECKED. Losing that would swap one blind spot for another.
    const specs = typecheck.files.filter((f) => f.endsWith('.spec.ts'));
    expect(specs).toContain('apps/api/src/config/typecheck-coverage.spec.ts');
    expect(specs).toContain('apps/api/src/config/financial-owner-preflight.spec.ts');
    expect(specs.length).toBeGreaterThan(5);
  });

  it('weakens no compiler flag to achieve any of this', () => {
    /*
     * The cheap way to make a test tree type-check is to stop checking it
     * properly. Every strictness flag the typecheck program runs under must be
     * the one the build already ran under — inherited, not redeclared.
     */
    for (const flag of [
      'strict',
      'strictNullChecks',
      'noImplicitAny',
      'strictFunctionTypes',
      'noUnusedLocals',
      'noUnusedParameters',
      'exactOptionalPropertyTypes',
      'noImplicitOverride',
      'skipLibCheck',
    ] as const) {
      expect({ flag, value: typecheck.options[flag] }).toEqual({ flag, value: build.options[flag] });
    }
    expect(typecheck.options.strict).toBe(true);
  });

  it('declares no second path map that could drift from the base', () => {
    // `runtime-path-map.spec.ts` exists because two hand-maintained copies of
    // one table drift. A third copy here would be the same bug with a new file
    // name, so the config must inherit the map rather than restate it.
    const raw = ts.readConfigFile(resolve(WORKSPACE_ROOT, TYPECHECK_CONFIG), ts.sys.readFile);
    expect(raw.config.compilerOptions?.paths).toBeUndefined();
    expect(raw.config.extends).toBe('./tsconfig.json');
  });
});

describe('the Nx target really runs that program', () => {
  /*
   * The config being correct is worth nothing if `api:typecheck` points
   * somewhere else. This is the join between the two, and it is a single token
   * in `project.json` — exactly the kind of edit that leaves every other test
   * green.
   */
  const project = JSON.parse(
    ts.sys.readFile(resolve(API_ROOT, 'project.json')) ?? '',
  ) as { targets: Record<string, { options?: { command?: string } }> };

  it('binds `typecheck` to the whole-program config', () => {
    expect(project.targets.typecheck.options?.command).toBe('tsc -p apps/api/tsconfig.typecheck.json');
  });

  it('leaves `build` on the source-only config', () => {
    expect(project.targets.build.options?.command).toBe('tsc -p apps/api/tsconfig.json');
  });
});
