/**
 * @jest-environment node
 */
// `next/font/local` only exists inside the Next compiler; the layout is
// imported here for its `metadata` alone.
jest.mock('@/app/fonts', () => ({ anjoman: { variable: '' }, peyda: { variable: '' }, vazir: { variable: '' } }));

import { metadata as rootMetadata } from '@/app/layout';
import { metadata as searchMetadata } from '@/app/search/layout';
import type { ProviderSummary } from '@/lib/booking-api';
import { SITE_DESCRIPTION, fetchPublic, openGraphFor, providerMetadata, providerPageMetadata, safeMetadataBase } from '@/lib/seo';

/**
 * Per-route metadata -- `32_SEO_METADATA.md`.
 *
 * What is pinned is what the spec forbids as much as what it asks for: no
 * invented wording, no digit conversion, and a fetch that fails costs a page
 * its enrichment and never its render.
 */

const provider = (over: Partial<ProviderSummary> = {}): ProviderSummary => ({
  id: 'p-1',
  displayName: 'سالن نگین',
  bio: null,
  cityId: 'c-1',
  specialties: [
    { id: 's1', name: 'آرایشگر' },
    { id: 's2', name: 'مانیکور' },
  ],
  verificationStatus: 'verified',
  images: { avatar: null, cover: null },
  rating: { average: null, count: 0 },
  saved: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const avatar = (url: string | null) => ({
  images: { avatar: { id: 'm1', url, contentType: 'image/jpeg', width: 1, height: 1 }, cover: null },
});

describe('the site-wide metadata', () => {
  it('keeps the description the app already shipped, word for word', () => {
    // The final brand sentence is a business decision (spec 32); this layer
    // adds structure and must not have edited the wording.
    expect(SITE_DESCRIPTION).toBe('مارکت‌پلیس هوشمند زیبایی');
    expect(rootMetadata.description).toBe('مارکت‌پلیس هوشمند زیبایی');
  });

  it('declares the Persian locale and the site name on Open Graph', () => {
    expect(rootMetadata.openGraph).toMatchObject({ locale: 'fa_IR', siteName: 'BeauClick' });
  });

  it('gives every page a suffix through the title template, and the home page the bare name', () => {
    expect(rootMetadata.title).toEqual({ default: 'BeauClick', template: '%s | BeauClick' });
  });

  it('does not name the home page as the address of every page that sets no url of its own', () => {
    expect(rootMetadata.openGraph).not.toHaveProperty('url');
  });

  it('has a metadataBase so relative image and canonical paths become absolute', () => {
    expect(rootMetadata.metadataBase).toBeInstanceOf(URL);
  });
});

describe('metadataBase', () => {
  it('falls back to a valid URL rather than throwing when the configured origin is not one', () => {
    expect(() => safeMetadataBase('not a url')).not.toThrow();
    expect(safeMetadataBase('not a url').href).toMatch(/^http:\/\/localhost/);
    expect(safeMetadataBase('https://beauclick.example').origin).toBe('https://beauclick.example');
  });
});

describe('openGraphFor', () => {
  it('restates the locale and site name, which a child would otherwise lose', () => {
    expect(openGraphFor({ title: 'x', path: '/x' })).toMatchObject({ locale: 'fa_IR', siteName: 'BeauClick', url: '/x' });
  });
});

describe('the search page', () => {
  it('uses the label the site already uses for the destination, and a canonical path', () => {
    expect(searchMetadata.title).toBe('جست‌وجوی متخصص');
    expect(searchMetadata.alternates).toEqual({ canonical: '/search' });
    expect(searchMetadata.openGraph).toMatchObject({ locale: 'fa_IR' });
  });

  it('does not restate the description, so it inherits the site-wide one', () => {
    expect(searchMetadata).not.toHaveProperty('description');
  });
});

describe('providerMetadata', () => {
  it('builds the title and description from the name, specialties and city -- and nothing else', () => {
    const md = providerMetadata(provider(), 'تهران');
    expect(md.title).toBe('سالن نگین');
    expect(md.description).toBe('سالن نگین، آرایشگر، مانیکور در تهران');
  });

  it('does not use the free-text bio', () => {
    const md = providerMetadata(provider({ bio: 'متن دلخواه متخصص' }), 'تهران');
    expect(JSON.stringify(md)).not.toContain('متن دلخواه');
  });

  it('leaves Latin and Western digits exactly as they are', () => {
    const md = providerMetadata(provider({ displayName: 'Salon 24' }), null);
    expect(md.title).toBe('Salon 24');
    expect(md.description).toBe('Salon 24، آرایشگر، مانیکور');
    // No conversion to Persian digits anywhere in the metadata.
    expect(JSON.stringify(md)).not.toMatch(/[۰-۹]/);
  });

  it('omits the description when there is nothing to describe, so the site one is inherited', () => {
    const md = providerMetadata(provider({ specialties: [] }), null);
    expect(md).not.toHaveProperty('description');
  });

  it('uses the avatar as the share image, absolute, with the square card', () => {
    const md = providerMetadata(provider(avatar('https://cdn.example.test/a.jpg')), null);
    expect(md.openGraph).toMatchObject({ images: ['https://cdn.example.test/a.jpg'], locale: 'fa_IR' });
    expect(md.twitter).toMatchObject({ card: 'summary', images: ['https://cdn.example.test/a.jpg'] });
  });

  it.each([
    ['there is no avatar', provider()],
    ['the avatar has no public url', provider(avatar(null))],
    ['the url is relative, which no messenger can resolve', provider(avatar('/media/a.jpg'))],
  ])('falls back to the default image when %s', (_why, p) => {
    const md = providerMetadata(p, null);
    expect(md.openGraph).toMatchObject({ images: ['/opengraph-image'] });
    expect(md.twitter).toMatchObject({ card: 'summary_large_image', images: ['/twitter-image'] });
  });

  it("names the profile's own path as the canonical address", () => {
    const md = providerMetadata(provider({ id: 'abc' }), null);
    expect(md.alternates).toEqual({ canonical: '/providers/abc' });
    expect(md.openGraph).toMatchObject({ url: '/providers/abc' });
  });
});

describe('providerPageMetadata -- generateMetadata for /providers/[id]', () => {
  const ok = (data: unknown, meta: unknown = null) =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('reads the profile and the city list, and joins the city name to the cityId', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      url.endsWith('/v1/providers/cities') ? ok([{ id: 'c-1', name: 'یزد' }]) : ok(provider()),
    );
    const md = await providerPageMetadata('p-1');
    expect(md.description).toBe('سالن نگین، آرایشگر، مانیکور در یزد');
  });

  it('still describes the professional when the city cannot be resolved', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      url.endsWith('/v1/providers/cities') ? Promise.reject(new Error('down')) : ok(provider()),
    );
    const md = await providerPageMetadata('p-1');
    expect(md.description).toBe('سالن نگین، آرایشگر، مانیکور');
  });

  it.each([
    ['the API is unreachable', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['the profile does not exist', () => Promise.resolve({ ok: false, status: 404, json: async () => ({ data: null, error: {} }) })],
    ['the server errors', () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })],
    ['the body is not JSON', () => Promise.resolve({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('x')) })],
    ['the body is not a profile', () => ok({ unexpected: true })],
    ['the body is empty', () => ok(null)],
  ])('degrades to the generic metadata, and does not throw, when %s', async (_why, respond) => {
    (global.fetch as jest.Mock).mockImplementation(respond);
    await expect(providerPageMetadata('p-1')).resolves.toEqual({});
  });

  it('puts the id in the request path encoded, so it cannot inject a path segment', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => ok(null));
    await providerPageMetadata('../admin');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/v1/providers/..%2Fadmin');
  });
});

describe('fetchPublic', () => {
  it('reads the pagination total from the envelope', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [1], meta: { pagination: { total: 7 } }, error: null }),
    });
    await expect(fetchPublic('/v1/x')).resolves.toEqual({ data: [1], total: 7 });
  });

  it('sends no credentials and no cookies: it is an anonymous read', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], error: null }) });
    await fetchPublic('/v1/x');
    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.credentials).toBeUndefined();
  });
});
