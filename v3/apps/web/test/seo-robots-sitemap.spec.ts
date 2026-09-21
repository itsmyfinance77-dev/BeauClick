/**
 * @jest-environment node
 */
import robots, { PRIVATE_PATHS, PUBLIC_PATHS } from '@/app/robots';
import sitemap from '@/app/sitemap';
import { SITE_URL } from '@/lib/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * robots.txt and sitemap.xml -- `32_SEO_METADATA.md`. Both are plain
 * functions, so the output is asserted directly.
 */

describe('robots', () => {
  const rule = () => {
    const rules = robots().rules;
    return (Array.isArray(rules) ? rules[0] : rules) as { userAgent: string; allow: string[]; disallow: string[] };
  };

  it('allows the spec public routes', () => {
    expect(rule().allow).toEqual(expect.arrayContaining(['/', '/search', '/providers/']));
  });

  it('disallows the four prefixes the spec names as the minimum', () => {
    expect(rule().disallow).toEqual(expect.arrayContaining(['/account/', '/pro/', '/admin/', '/checkout/']));
  });

  it('never disallows a path that is also public', () => {
    // `/` is a prefix of everything; the check is the other direction -- that
    // no private prefix swallows a public route -- which is what an over-broad
    // addition would do.
    for (const priv of PRIVATE_PATHS) {
      for (const pub of PUBLIC_PATHS.filter((p) => p !== '/')) {
        expect(pub.startsWith(priv)).toBe(false);
      }
    }
  });

  it('only disallows routes that exist and sit behind a sign-in', () => {
    // Every extra prefix beyond the spec's four must name a real route whose
    // page is guarded, so the list cannot drift into hiding a public page.
    const app = join(__dirname, '..', 'app');
    const spec = new Set(['/account/', '/pro/', '/admin/', '/checkout/']);
    for (const prefix of PRIVATE_PATHS.filter((p) => !spec.has(p))) {
      const page = join(app, prefix.slice(1), 'page.tsx');
      expect(statSync(page).isFile()).toBe(true);
      expect(readFileSync(page, 'utf8')).toMatch(/ProtectedRoute/);
    }
  });

  it('names the sitemap by its absolute address', () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});

describe('sitemap', () => {
  const list = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `p-${from + i}`, displayName: 'x', createdAt: '2026-01-01T00:00:00.000Z' }));
  const page = (items: unknown[], total: number) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: items, meta: { pagination: { total } }, error: null }),
  });

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('lists the home page, search and every public professional, by absolute URL', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(page(list(2), 2));
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${SITE_URL}/`, `${SITE_URL}/search`, `${SITE_URL}/providers/p-0`, `${SITE_URL}/providers/p-1`]);
  });

  it('carries no lastmod: the public shape has no updatedAt and createdAt is not a modification date', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(page(list(3), 3));
    for (const entry of await sitemap()) expect(entry).not.toHaveProperty('lastModified');
  });

  it('reads every page of the listing, not just the first', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(page(list(100), 150))
      .mockResolvedValueOnce(page(list(50, 100), 150));
    const entries = await sitemap();
    expect(entries).toHaveLength(2 + 150);
    const requested = (global.fetch as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(requested[0]).toContain('page=1&limit=100');
    expect(requested[1]).toContain('page=2&limit=100');
  });

  it('stops when the total is reached, without an extra request', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(page(list(100), 100));
    await sitemap();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('is the two static entries, and does not throw, when the API is unreachable', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${SITE_URL}/`, `${SITE_URL}/search`]);
  });

  it('keeps what it has when a later page fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(page(list(100), 250))
      .mockRejectedValueOnce(new Error('timeout'));
    expect(await sitemap()).toHaveLength(2 + 100);
  });

  it('is the two static entries when the API answers with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect(await sitemap()).toHaveLength(2);
  });

  it('skips an item with no usable id rather than emitting /providers/undefined', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(page([{ id: 'ok-1' }, { id: '' }, {}, null], 4));
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${SITE_URL}/`, `${SITE_URL}/search`, `${SITE_URL}/providers/ok-1`]);
  });

  it('does not list a private or legal-placeholder route', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(page(list(1), 1));
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    for (const path of ['/account', '/admin', '/pro', '/checkout', '/terms', '/privacy-policy', '/contact', '/support']) {
      // By path segment, not substring: `/providers/...` starts with `/pro`.
      expect(paths.filter((p) => p === path || p.startsWith(`${path}/`))).toEqual([]);
    }
  });
});

describe('the metadata files', () => {
  // A route handler file that quietly went missing would fail the build only
  // when the route is requested; this pins that they exist.
  const app = join(__dirname, '..', 'app');
  const files = readdirSync(app);

  it.each(['robots.ts', 'sitemap.ts', 'opengraph-image.png', 'twitter-image.png', 'apple-icon.png'])('%s exists', (name) => {
    expect(files).toContain(name);
  });
});
