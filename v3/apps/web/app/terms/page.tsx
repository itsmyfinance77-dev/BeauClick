import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';

const TITLE = 'قوانین و مقررات';

/**
 * A placeholder until the terms are approved (`33_FOOTER_LEGAL.md`), so it
 * asks search engines not to index it: a page that says "awaiting approval"
 * is not one to show in results. Drop `robots` when the text lands.
 */
export const metadata: Metadata = { title: TITLE, robots: { index: false, follow: true } };

export default function TermsPage() {
  return <LegalPage title={TITLE} />;
}
