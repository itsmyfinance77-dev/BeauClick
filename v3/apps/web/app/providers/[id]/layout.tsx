import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { providerPageMetadata } from '@/lib/seo';

/**
 * A server layout beside a client page, because `generateMetadata` cannot live
 * in a `'use client'` module. The profile is read from the public API; if that
 * fails for any reason the page still renders, with the site-wide metadata.
 */
export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  return providerPageMetadata(params.id);
}

export default function ProviderLayout({ children }: { children: ReactNode }) {
  return children;
}
