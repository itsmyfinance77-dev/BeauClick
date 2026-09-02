import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The runtime path map must not drift from the source path map.
 *
 * ## The bug this exists to make impossible
 *
 * `tsconfig.base.json` maps every `@beauclick/*` specifier to a package's
 * TypeScript SOURCE. That is right for tests and for `api:dev`, and unusable at
 * runtime: Node cannot execute TypeScript. `infra/docker/tsconfig.runtime.json`
 * is the same table with every target rewritten to its compiled output under
 * `dist/`, and `tsconfig-paths` reads it inside the container.
 *
 * The two tables are maintained by hand. A mapping added to the base and
 * forgotten in the runtime copy produces a container that dies on its FIRST
 * IMPORT with `MODULE_NOT_FOUND` — and **no CI gate can see it**, because every
 * gate runs the source: typecheck, lint, build, the fast suite and the
 * real-PostgreSQL suite all resolve through `tsconfig.base.json` and pass
 * cleanly. The failure only appears when somebody boots the image.
 *
 * V3.3-A Story #40 hit exactly that. `app.module.ts` began importing
 * `@beauclick/commercial-policy`, all seven CI checks went green, and the
 * production container exited 1 on startup. The mapping for
 * `@beauclick/commercial-policy-contract` had ALSO been missing since Story
 * #39 — harmlessly, because nothing in the API imported it yet, which is
 * precisely how this class of defect waits.
 *
 * ## Why a test rather than a generator
 *
 * A generator would make the runtime file derived and correct, and it would
 * also make it invisible: nobody reviews generated output, and the container's
 * module resolution is load-bearing enough to deserve a reviewer. A comparison
 * keeps the file hand-written and honest, and turns "somebody remembered" into
 * a failing test — the same trade `libs/audit`'s boot assertion and ADR-027's
 * coverage check both make.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/** `tsconfig.*.json` files carry comments and a `"//"` key; JSON.parse handles the latter and not the former. */
function readTsconfig(relativePath: string): { compilerOptions: { paths: Record<string, string[]> } } {
  const raw = readFileSync(resolve(WORKSPACE_ROOT, relativePath), 'utf8');
  return JSON.parse(raw);
}

describe('the container runtime path map matches the source path map', () => {
  const base = readTsconfig('tsconfig.base.json').compilerOptions.paths;
  const runtime = readTsconfig('infra/docker/tsconfig.runtime.json').compilerOptions.paths;

  it('reads two real, populated tables', () => {
    // The discovery half: a comparison of two empty objects passes and proves
    // nothing.
    expect(Object.keys(base).length).toBeGreaterThan(30);
    expect(Object.keys(base)).toContain('@beauclick/commercial-policy');
  });

  it('maps every source specifier at runtime', () => {
    const missing = Object.keys(base).filter((specifier) => !(specifier in runtime));
    expect(missing).toEqual([]);
  });

  it('maps no specifier the source does not have', () => {
    // A stale runtime entry is the mirror-image failure: it resolves to a
    // `dist/` path for a package that no longer exists.
    const extra = Object.keys(runtime).filter((specifier) => !(specifier in base));
    expect(extra).toEqual([]);
  });

  it('points every runtime mapping at the COMPILED output of its source mapping', () => {
    const wrong: string[] = [];
    for (const [specifier, [sourceTarget]] of Object.entries(base)) {
      const [runtimeTarget] = runtime[specifier] ?? [];
      const expected = `dist/${sourceTarget.replace(/\.ts$/, '.js')}`;
      if (runtimeTarget !== expected) wrong.push(`${specifier}: expected ${expected}, found ${runtimeTarget ?? '(absent)'}`);
    }
    expect(wrong).toEqual([]);
  });

  it('would catch a forgotten mapping, so the assertions above are not vacuous', () => {
    // The probe, run against copies rather than by editing the real files.
    const withoutOne = { ...runtime };
    delete withoutOne['@beauclick/commercial-policy'];
    expect(Object.keys(base).filter((s) => !(s in withoutOne))).toEqual(['@beauclick/commercial-policy']);

    // And a mapping that points at the SOURCE rather than the build output --
    // the other way this file has been got wrong -- is a finding too.
    const pointingAtSource = { ...runtime, '@beauclick/commercial-policy': ['services/commercial-policy/src/index.ts'] };
    const expected = `dist/${base['@beauclick/commercial-policy'][0].replace(/\.ts$/, '.js')}`;
    expect(pointingAtSource['@beauclick/commercial-policy'][0]).not.toBe(expected);
  });
});
