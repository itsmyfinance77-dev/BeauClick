import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/config';
import type { ProviderSummary } from '@/lib/booking-api';
import { fetchPublic } from '@/lib/seo';

/**
 * The home page, search, and every public professional.
 *
 * **No `lastmod`.** The spec asks for `updatedAt`, but the public professional
 * shape does not carry one -- it has `createdAt` only, and a creation date is
 * not a modification date. Claiming one would tell a crawler a profile has not
 * changed when it may have; leaving the field out says nothing untrue. It
 * becomes a one-line addition when the API returns `updatedAt`.
 *
 * The list is read a page at a time (the API caps a page at 100). If the API is
 * unreachable, or fails midway, the sitemap is what was collected so far --
 * the two static entries at worst -- and neither the build nor the request
 * fails. It is regenerated hourly, so a build made while the API was down does
 * not freeze the sitemap without professionals.
 */
export const revalidate = 3600;

const PAGE_SIZE = 100;
/** The sitemap protocol allows 50,000 URLs in one file; this stops well short and bounds the loop. */
const MAX_PAGES = 400;

async function listProviderIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchPublic<ProviderSummary[]>(`/v1/providers?page=${page}&limit=${PAGE_SIZE}`);
    if (!result || !Array.isArray(result.data) || result.data.length === 0) break;
    for (const provider of result.data) {
      if (typeof provider?.id === 'string' && provider.id) ids.push(provider.id);
    }
    if (result.data.length < PAGE_SIZE || (result.total !== null && ids.length >= result.total)) break;
  }
  return ids;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const providerIds = await listProviderIds();
  return [
    { url: `${SITE_URL}/` },
    { url: `${SITE_URL}/search` },
    ...providerIds.map((id) => ({ url: `${SITE_URL}/providers/${encodeURIComponent(id)}` })),
  ];
}
