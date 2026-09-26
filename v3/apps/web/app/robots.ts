import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/config';

/**
 * `32_SEO_METADATA.md`: the public routes are crawlable and the private ones
 * are not. `/`, `/search` and `/providers/*` are the spec's public set;
 * everything not disallowed is crawlable by default, so the allow list is
 * declarative.
 *
 * The first four disallowed prefixes are the spec's minimum. The rest are
 * signed-in-only pages (each sits behind `ProtectedRoute`) that a crawler
 * would only ever see as a redirect or an empty shell. Listing a path here is
 * not access control -- each one guards itself -- it only keeps them out of a
 * search index. `/auth` is deliberately absent: it is the sign-in page, which
 * is public, not a private surface.
 */
export const PUBLIC_PATHS = ['/', '/search', '/providers/'];

export const PRIVATE_PATHS = [
  '/account/',
  '/pro/',
  '/admin/',
  '/checkout/',
  '/assistant',
  '/bookings',
  '/business',
  '/dashboard',
  '/finance',
  '/journey',
  '/loyalty',
  '/notifications',
  '/referral',
  '/waitlist',
  '/wishlist',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: PUBLIC_PATHS, disallow: PRIVATE_PATHS }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
