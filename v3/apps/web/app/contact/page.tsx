import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';

const TITLE = 'تماس';

/**
 * The contact details (number, address, hours) are a business decision that
 * has not been made, so the block is the labelled placeholder -- never a
 * sample. Not indexed until they are; drop `robots` then.
 */
export const metadata: Metadata = { title: TITLE, robots: { index: false, follow: true } };

export default function ContactPage() {
  return <LegalPage title={TITLE} withContactBlock />;
}
