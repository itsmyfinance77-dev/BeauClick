import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * `useSearchParams()` without a Suspense boundary breaks `next build`.
 *
 * In the App Router the hook opts a component out of static prerendering,
 * and Next refuses to build the route unless a boundary marks where the
 * bail-out happens:
 *
 *   useSearchParams() should be wrapped in a suspense boundary at page
 *   "/search"
 *
 * The failure has a nasty shape. `next dev` renders perfectly, the type
 * checker is silent, the linter is silent, and every test passes — it
 * surfaces only in a production build. It happened here: the hook was added
 * to `app/search/page.tsx` to pick up the home page's `?q=`, and the branch
 * went to CI with a broken build behind 405 green tests.
 *
 * Every other page that reads the hook already had a boundary, so this is a
 * convention the codebase held and one change quietly broke. The check is
 * static and shallow on purpose: it reads each `page.tsx` and the modules it
 * imports from its own folder, which is where a page's client half lives.
 */

const APP = resolve(__dirname, '..', 'app');

function pageFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pageFiles(full, found);
    else if (entry === 'page.tsx') found.push(full);
  }
  return found;
}

/** The page's own source plus the sibling modules it imports with `./`. */
function sourceClosure(page: string): string {
  const own = readFileSync(page, 'utf8');
  const siblings = [...own.matchAll(/from\s+'\.\/([A-Za-z0-9._-]+)'/g)].map((m) => m[1]);
  const extra = siblings
    .map((name) => ['.tsx', '.ts'].map((ext) => join(dirname(page), `${name}${ext}`)))
    .flat()
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => readFileSync(candidate, 'utf8'));
  return [own, ...extra].join('\n');
}

describe('app router — useSearchParams needs a Suspense boundary', () => {
  const pages = pageFiles(APP);

  it('finds the routes it is supposed to be checking', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  const readers = pages.filter((page) => sourceClosure(page).includes('useSearchParams'));

  it('finds at least one route that reads the hook', () => {
    // Otherwise this suite would pass by checking nothing at all.
    expect(readers.length).toBeGreaterThan(0);
  });

  it.each(readers.map((p) => [p.slice(APP.length + 1).split('\\').join('/'), p]))(
    '%s wraps it in a Suspense boundary',
    (_label, page) => {
      // The ELEMENT, not the word: a doc comment that mentions Suspense, or
      // an import that is never rendered, satisfies neither Next nor a
      // reader. Verified by removing the boundary and watching this fail.
      expect(readFileSync(page as string, 'utf8')).toMatch(/<Suspense[\s>]/);
    },
  );
});
