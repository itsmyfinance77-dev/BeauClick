import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `var(--bc-…)` a screen reads must be a token something defines.
 *
 * An undefined custom property is silent: `var(--bc-color-danger)` resolves
 * to nothing, the declaration is dropped, and the element renders with the
 * inherited value. Nothing throws, nothing logs, and jsdom -- which does not
 * compute styles -- cannot see it either. So a refusal renders grey, an
 * input's corners go square, and the whole test suite stays green.
 *
 * That is not hypothetical. Three of them were live in this app at once:
 * `--bc-color-danger` (never a token at all), `--bc-radius-input` and
 * `--bc-color-surface-muted`. The design system named the last two eight days
 * before this file existed and they were still shipping.
 *
 * This is the check that would have caught all three, and it is mechanical:
 * read what is used, read what is defined, and subtract.
 */

const WEB = join(__dirname, '..');
const TOKENS_CSS = join(WEB, '../../packages/design-tokens/src/tokens.css');

/**
 * Emitted onto `<html>` by `next/font` at runtime (see `app/fonts.ts`), so
 * they are legitimately absent from the stylesheet. `tokens.css` reads both
 * through `var(…, fallback)` and never depends on them resolving.
 */
const RUNTIME_PROVIDED = new Set(['--bc-font-vazir', '--bc-font-anjoman']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(tsx?|css)$/.test(entry)) found.push(full);
  }
  return found;
}

/** `--bc-…` names read through `var()`, which is the only way a screen consumes one. */
function tokensReadBy(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/var\(\s*(--bc-[a-z0-9-]+)/g)].map((m) => m[1]);
}

const DEFINED = new Set(
  [...readFileSync(TOKENS_CSS, 'utf8').matchAll(/^\s*(--bc-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
);

describe('design tokens — every token a screen reads is defined', () => {
  const files = [...sourceFiles(join(WEB, 'app')), ...sourceFiles(join(WEB, 'components')), ...sourceFiles(join(WEB, 'lib'))];

  it('finds the source tree it is supposed to be scanning', () => {
    // Guards the suite against silently passing because a path moved.
    expect(files.length).toBeGreaterThan(30);
    expect(DEFINED.size).toBeGreaterThan(40);
    expect(DEFINED.has('--bc-color-primary')).toBe(true);
  });

  it('reports every undefined token with the file that reads it', () => {
    const undefinedUses: string[] = [];
    for (const file of files) {
      for (const token of new Set(tokensReadBy(file))) {
        if (DEFINED.has(token) || RUNTIME_PROVIDED.has(token)) continue;
        undefinedUses.push(`${token}  <-  ${file.slice(WEB.length + 1).split('\\').join('/')}`);
      }
    }
    // Listed rather than counted: a failure has to name what to go and fix.
    expect(undefinedUses.sort()).toEqual([]);
  });
});
