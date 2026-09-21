import type { Metadata } from 'next';
import { API_BASE_URL, SITE_URL } from './config';
import type { CityRef, ProviderSummary } from './booking-api';

/**
 * Metadata for the public surfaces -- `32_SEO_METADATA.md`.
 *
 * Two rules from the spec shape everything here:
 *
 *  - **Nothing is written for the customer.** The site description is the
 *    sentence `app/layout.tsx` already carried; the final brand sentence is a
 *    business decision, so it is moved here unchanged and not improved. A
 *    professional's title and description are assembled from their own public
 *    data (name, city, specialties) and from nothing else.
 *  - **Digits are left alone.** These strings are read by crawlers and
 *    messengers, not by a person looking at the page, so no Persian-digit
 *    conversion is applied.
 */

export const SITE_NAME = 'BeauClick';
export const SITE_DESCRIPTION = 'مارکت‌پلیس هوشمند زیبایی';
export const SITE_LOCALE = 'fa_IR';

/** How long a crawler-facing fetch may take before the page falls back to the generic metadata. */
const FETCH_TIMEOUT_MS = 3000;
/** Profile data changes rarely and metadata is read by bots, so a short cache keeps the API out of the render path. */
const REVALIDATE_SECONDS = 300;

/** `metadataBase` must be a valid URL or Next throws at build time; a bad env value must not take the build down. */
export function safeMetadataBase(origin: string = SITE_URL): URL {
  try {
    return new URL(origin);
  } catch {
    return new URL('http://localhost:3100');
  }
}

/**
 * The Open Graph block every page repeats. Next replaces a child's
 * `openGraph` wholesale rather than merging it with the parent's, so a page
 * that sets its own title would otherwise lose `og:locale` and `og:site_name`.
 */
export function openGraphFor(fields: {
  title: string;
  description?: string;
  /**
   * The page's own path. Left out of the site-wide block: a `url` set there
   * would be inherited by every page that does not set its own and name the
   * home page as their address.
   */
  path?: string;
  images?: string[];
}): NonNullable<Metadata['openGraph']> {
  return {
    type: 'website',
    siteName: SITE_NAME,
    locale: SITE_LOCALE,
    title: fields.title,
    description: fields.description,
    ...(fields.path ? { url: fields.path } : {}),
    ...(fields.images ? { images: fields.images } : {}),
  };
}

/**
 * A GET against the public API that can only ever succeed or return `null`.
 * Metadata and the sitemap are built by the server with nobody watching, so a
 * slow or unreachable API has to cost a page its enrichment and never its
 * render -- or the build.
 */
export async function fetchPublic<T>(path: string): Promise<{ data: T; total: number | null } | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: T | null;
      meta?: { pagination?: { total?: number } } | null;
    } | null;
    if (!body || body.data === null || body.data === undefined) return null;
    return { data: body.data, total: body.meta?.pagination?.total ?? null };
  } catch {
    return null;
  }
}

/** The avatar's URL when it is a real, absolute one. Anything else is "no picture", never a broken image. */
function avatarUrl(provider: ProviderSummary): string | null {
  const url = provider.images?.avatar?.url;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

/**
 * Title, description and image for one professional, from their public
 * profile. A field the profile does not have is left out, so it is inherited
 * from the site-wide metadata rather than replaced by an invented phrase.
 */
export function providerMetadata(provider: ProviderSummary, cityName: string | null): Metadata {
  const specialties = (provider.specialties ?? []).map((s) => s.name).filter(Boolean);
  const detail = [specialties.length > 0 ? specialties.join('، ') : null, cityName ? `در ${cityName}` : null].filter(
    (part): part is string => part !== null,
  );
  const description = detail.length > 0 ? `${provider.displayName}، ${detail.join(' ')}` : undefined;
  const path = `/providers/${provider.id}`;
  const avatar = avatarUrl(provider);

  return {
    title: provider.displayName,
    ...(description ? { description } : {}),
    alternates: { canonical: path },
    openGraph: openGraphFor({
      title: provider.displayName,
      description,
      path,
      // No avatar: the default image, not a missing one.
      images: [avatar ?? '/opengraph-image'],
    }),
    twitter: {
      // A profile photo is square and a wide card would crop it.
      card: avatar ? 'summary' : 'summary_large_image',
      title: provider.displayName,
      description,
      images: [avatar ?? '/twitter-image'],
    },
  };
}

/**
 * `generateMetadata` for `/providers/[id]`. Any failure -- the API down, a 404,
 * a body that is not a profile -- yields `{}`, and the page inherits the
 * site-wide metadata.
 */
export async function providerPageMetadata(id: string): Promise<Metadata> {
  const profile = await fetchPublic<ProviderSummary>(`/v1/providers/${encodeURIComponent(id)}`);
  if (!profile || typeof profile.data.displayName !== 'string' || !profile.data.displayName) return {};

  let cityName: string | null = null;
  if (profile.data.cityId) {
    const cities = await fetchPublic<CityRef[]>('/v1/providers/cities');
    cityName = cities?.data.find((c) => c.id === profile.data.cityId)?.name ?? null;
  }
  return providerMetadata(profile.data, cityName);
}
