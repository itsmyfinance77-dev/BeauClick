import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';

const TITLE = 'حریم خصوصی';

/**
 * The privacy POLICY -- a legal document, currently a placeholder
 * (`33_FOOTER_LEGAL.md`). It is not `/account/privacy`, which is the signed-in
 * page for a person's own data requests. Not indexed until the text is
 * approved; drop `robots` then.
 */
export const metadata: Metadata = { title: TITLE, robots: { index: false, follow: true } };

export default function PrivacyPolicyPage() {
  return <LegalPage title={TITLE} />;
}
