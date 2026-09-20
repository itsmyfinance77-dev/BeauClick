import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { BREAKPOINT_DESKTOP, BREAKPOINT_MOBILE, BREAKPOINT_TABLET } from '@beauclick/design-tokens';

/**
 * Every width in an `@media` query is one of the design's breakpoints.
 *
 * `tokens.json` defines them once (640 and 1024, from
 * `V3.3_RESPONSIVE_AND_A11Y_HANDOFF.md` §1). A stylesheet cannot read a JSON
 * token — custom properties do not work inside a media query — so each CSS
 * file retypes the number. Before the styling layer existed the app carried
 * 560 and 900, which matched nothing in the design and could not be
 * corrected without finding them by eye.
 *
 * The rule: `min-width` is a breakpoint, `max-width` is a breakpoint minus
 * one pixel (the complement of the same `min-width`, so no width is covered
 * by both or by neither). Anything else is a number somebody invented.
 */

const WEB = join(__dirname, '..');

function cssFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, found);
    else if (entry.endsWith('.css')) found.push(full);
  }
  return found;
}

const px = (value: string) => Number.parseInt(value, 10);
const TABLET = px(BREAKPOINT_TABLET);
const DESKTOP = px(BREAKPOINT_DESKTOP);

describe('breakpoints — the design has three ranges and CSS uses only those', () => {
  it('reads the same numbers the handoff states', () => {
    expect(px(BREAKPOINT_MOBILE)).toBe(640);
    expect(TABLET).toBe(640);
    expect(DESKTOP).toBe(1024);
  });

  it('finds the stylesheets it is supposed to be checking', () => {
    const files = cssFiles(join(WEB, 'app')).concat(cssFiles(join(WEB, 'components')));
    expect(files.length).toBeGreaterThan(8);
  });

  it('uses no width in a media query that is not a breakpoint', () => {
    const allowed = new Set([`min-width:${TABLET}`, `min-width:${DESKTOP}`, `max-width:${TABLET - 1}`, `max-width:${DESKTOP - 1}`]);
    const stray: string[] = [];
    let queries = 0;

    for (const file of cssFiles(join(WEB, 'app')).concat(cssFiles(join(WEB, 'components')))) {
      const text = readFileSync(file, 'utf8');
      // Only real queries: the block comments in these files mention `@media`.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const query of code.matchAll(/@media[^{]*/g)) {
        for (const width of query[0].matchAll(/\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)/g)) {
          queries += 1;
          if (!allowed.has(`${width[1]}-width:${width[2]}`)) {
            stray.push(`${width[0].trim()}  <-  ${file.slice(WEB.length + 1).split(sep).join('/')}`);
          }
        }
      }
    }

    // A guard that matched nothing would pass forever.
    expect(queries).toBeGreaterThan(20);
    expect(stray).toEqual([]);
  });
});
