import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Every CSS-module class a component names exists, and every class a module
 * defines is named by something.
 *
 * Why this is a test that reads files off disk, and not something a component
 * test can do: `test/style-mock.js` is an identity proxy. `styles.anything`
 * returns the string `'anything'` whether or not the class exists, so a
 * reference to a class that was never defined — or was deleted, or renamed —
 * passes every jsdom test by construction. That is not an oversight to close:
 * without the proxy every module-styled element would render `class="undefined"`
 * and each structural assertion in the suite would be asserting on nothing.
 * jsdom therefore can never see a missing class, and neither can lint or
 * `tsc` (CSS-module typings are `Record<string, string>`). #291 shipped exactly
 * that way: `provider-card.tsx` referenced `styles.saveSuffix`, the rule had
 * been moved out of its module, and nothing failed. This file is the only
 * thing that can, for the same reason `breakpoints.spec.ts` reads CSS off disk:
 * the fact being checked lives in a stylesheet a test runner never evaluates.
 *
 * Both directions, and only what can be proven:
 *
 *  1. MISSING — a static `styles.foo` / `styles['foo']` in a file must name a
 *     class defined in the module that file imports it from. Always checked.
 *  2. UNREFERENCED — every class a module defines must be named statically by
 *     at least one importer. Skipped for a module that any importer reaches with
 *     a computed key (`styles[tone]`, `styles[`state_${x}`]`) or passes around
 *     as a bare object: which classes those select is not knowable statically,
 *     and this check does not guess. It reports only what it can prove.
 *
 * A third finding, so a green run never means "saw nothing": an import that names
 * a `.module.css` the walk did not collect is reported, not skipped — otherwise
 * that file's references would silently drop out of both directions above.
 *
 * Known reading: `styles?.foo` is treated as an opaque use of the binding, not as
 * a named reference (no such access exists in the app today).
 *
 * A class that is used only by another selector in the same stylesheet
 * (`.list .count { … }`) still counts as unreferenced: the stylesheet cannot
 * consume its own class, only markup can.
 */

const WEB = join(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.next', 'test']);

function walk(dir: string, match: (name: string) => boolean, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, found);
    else if (match(entry)) found.push(full);
  }
  return found;
}

const posix = (file: string) => relative(WEB, file).split(sep).join('/');

/** Block and line comments out — they quote `styles.foo` and `.foo {` as prose. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The classes a stylesheet defines: every `.name` in a selector, none in a declaration or an at-rule prelude. */
export function definedClasses(css: string): Set<string> {
  const defined = new Set<string>();
  const code = stripComments(css);
  // Everything up to each `{`, less what came before the previous `;`, `{` or `}`, is a prelude.
  for (const chunk of code.matchAll(/([^{};]*)\{/g)) {
    const prelude = chunk[1].trim();
    if (prelude.startsWith('@')) continue;
    for (const name of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(name[1]);
  }
  return defined;
}

export interface Usage {
  /** Classes named statically, `styles.foo` or `styles['foo']`. */
  named: Set<string>;
  /** The binding is used in a way this check cannot resolve. */
  opaque: boolean;
}

/** How one source file uses the binding it imported a module as. */
export function usageOf(source: string, binding: string): Usage {
  const code = stripComments(source);
  const named = new Set<string>();
  let opaque = false;
  const name = binding.replace(/\$/g, '\\$');

  for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])(\\s*)(\\.\\s*([\\w$-]+)|\\[\\s*(['"])([^'"]+)\\4\\s*\\]|\\[|)`, 'g'))) {
    if (use[3]) named.add(use[3]);
    else if (use[5]) named.add(use[5]);
    else if (use[2] !== '') opaque = true; // `styles[expr]`
    else if (!/^\s*import\b/.test(code.slice(code.lastIndexOf('\n', use.index!) + 1, use.index!) + 'x')) opaque = true; // bare `styles`
  }
  return { named, opaque };
}

interface Importer {
  file: string;
  module: string;
  binding: string;
}

const IMPORT = /import\s+([\w$]+)\s+from\s+['"]([^'"]+\.module\.css)['"]/g;

export function importsOf(file: string, source: string): Importer[] {
  return [...stripComments(source).matchAll(IMPORT)].map((m) => ({
    file,
    binding: m[1],
    module: resolve(dirname(file), m[2]),
  }));
}

export interface Findings {
  unresolved: string[];
  missing: string[];
  unreferenced: string[];
}

/** The whole check, over already-read text — so it can be exercised on synthetic input. */
export function audit(sources: Map<string, string>, stylesheets: Map<string, string>): Findings {
  const definitions = new Map([...stylesheets].map(([file, css]) => [file, definedClasses(css)]));
  const referenced = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  const missing: string[] = [];
  const unresolved: string[] = [];

  for (const [file, source] of sources) {
    for (const imp of importsOf(file, source)) {
      const defined = definitions.get(imp.module);
      if (!defined) {
        unresolved.push(
          `${posix(file)}: imports ${posix(imp.module)}, which the stylesheet walk did not find — ` +
            `none of this file's styles.* references can be checked until the path resolves`,
        );
        continue;
      }
      const usage = usageOf(source, imp.binding);
      if (usage.opaque) opaque.add(imp.module);
      const seen = referenced.get(imp.module) ?? new Set<string>();
      for (const name of usage.named) {
        seen.add(name);
        if (!defined.has(name)) {
          missing.push(
            `${posix(file)}: \`${imp.binding}.${name}\` is not defined in ${posix(imp.module)} — ` +
              `the element gets no styles (the test mock returns a string for any name, so no other test can see this)`,
          );
        }
      }
      referenced.set(imp.module, seen);
    }
  }

  const unreferenced: string[] = [];
  for (const [module, defined] of definitions) {
    if (opaque.has(module)) continue;
    const seen = referenced.get(module) ?? new Set<string>();
    for (const name of defined) {
      if (!seen.has(name)) {
        unreferenced.push(
          `${posix(module)}: \`.${name}\` is defined but no file that imports this module names it — ` +
            `delete the rule, or reference it if a rename left it behind`,
        );
      }
    }
  }
  return { unresolved, missing, unreferenced };
}

describe('the checker itself — exercised on synthetic input, so a silent parser bug cannot pass the real check', () => {
  const at = (name: string) => join(WEB, name);
  const run = (tsx: string, css: string) =>
    audit(new Map([[at('a.tsx'), tsx]]), new Map([[at('a.module.css'), css]]));
  const head = "import styles from './a.module.css';\n";

  it('reports a class a file names but the module does not define', () => {
    const { missing } = run(`${head}const x = <p className={styles.gone} />;`, '.here { color: red; }');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('a.tsx');
    expect(missing[0]).toContain('styles.gone');
    expect(missing[0]).toContain('a.module.css');
  });

  it('reports a defined class nothing names, and reads bracket access as a name', () => {
    const { missing, unreferenced } = run(`${head}const x = styles['here'];`, '.here { a: b; } .dead { a: b; }');
    expect(missing).toEqual([]);
    expect(unreferenced).toHaveLength(1);
    expect(unreferenced[0]).toContain('.dead');
  });

  it('sees classes in compound and nested selectors, and not numbers, at-rules or comments', () => {
    const css = '/* .commented { } */ @media (min-width: 640px) { .a.b > .c:hover { margin: 0.5px; } } @keyframes spin { from { x: 1; } }';
    expect([...definedClasses(css)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a computed key opts the module out of the unreferenced direction only', () => {
    const { missing, unreferenced } = run(`${head}const x = styles[tone]; const y = styles.gone;`, '.variant { a: b; }');
    expect(unreferenced).toEqual([]);
    expect(missing).toHaveLength(1);
  });

  it('a bare `styles` is opaque too, but the import line is not', () => {
    expect(run(`${head}const x = 1;`, '.dead { a: b; }').unreferenced).toHaveLength(1);
    expect(run(`${head}helper(styles);`, '.dead { a: b; }').unreferenced).toEqual([]);
  });

  it('reports an import it cannot resolve instead of skipping the file', () => {
    const { unresolved, missing } = audit(
      new Map([[at('a.tsx'), "import styles from './nowhere.module.css';\nconst x = styles.gone;"]]),
      new Map([[at('a.module.css'), '.here { a: b; }']]),
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toContain('a.tsx');
    expect(unresolved[0]).toContain('nowhere.module.css');
    expect(missing).toEqual([]);
  });

  it('ignores a class named only in a comment', () => {
    const { unreferenced } = run(`${head}// styles.dead is gone\nconst x = styles.live;`, '.live { a: b; } .dead { a: b; }');
    expect(unreferenced).toHaveLength(1);
  });
});

describe('css modules — every reference resolves, and every definition is reachable', () => {
  const sourceFiles = walk(WEB, (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'));
  const sources = new Map(sourceFiles.map((f) => [f, readFileSync(f, 'utf8')]));
  const stylesheets = new Map(walk(WEB, (n) => n.endsWith('.module.css')).map((f) => [f, readFileSync(f, 'utf8')]));
  const { unresolved, missing, unreferenced } = audit(sources, stylesheets);

  it('finds what it is supposed to be checking', () => {
    // A check that matched nothing would pass forever.
    const imports = [...sources].flatMap(([file, text]) => importsOf(file, text));
    const refs = imports.reduce((n, imp) => n + usageOf(sources.get(imp.file)!, imp.binding).named.size, 0);
    expect(stylesheets.size).toBeGreaterThan(40);
    expect(imports.length).toBeGreaterThan(50);
    expect(refs).toBeGreaterThan(500);
  });

  it('imports only stylesheets it can see', () => {
    expect(unresolved).toEqual([]);
  });

  it('never names a class its module does not define', () => {
    expect(missing).toEqual([]);
  });

  it('defines no class that nothing names (modules with a computed access excepted)', () => {
    expect(unreferenced).toEqual([]);
  });
});
