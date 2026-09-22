import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { openGraphFor } from '@/lib/seo';

/**
 * A server layout beside a client page, because `metadata` cannot be exported
 * from a `'use client'` module. The title is the label the footer and header
 * already use for this destination; the description is inherited.
 */
const TITLE = 'جست‌وجوی متخصص';

export const metadata: Metadata = {
  title: TITLE,
  alternates: { canonical: '/search' },
  openGraph: openGraphFor({ title: TITLE, path: '/search' }),
  // A page's `twitter` replaces the site-wide one, so the card is restated.
  twitter: { card: 'summary_large_image', title: TITLE },
};

export default function SearchLayout({ children }: { children: ReactNode }) {
  return children;
}
