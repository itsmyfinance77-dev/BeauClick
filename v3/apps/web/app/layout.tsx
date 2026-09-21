import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { SITE_DESCRIPTION, SITE_NAME, openGraphFor, safeMetadataBase } from '@/lib/seo';
import { AppShell } from '@/components/app-shell';
import { anjoman, peyda, vazir } from './fonts';
import './globals.css';

/**
 * The site-wide defaults every route inherits. The description is the wording
 * the app already shipped (`lib/seo.ts`): the final brand sentence is a
 * business decision, not one this layer writes. Pages that set their own
 * `title` get the ` | BeauClick` suffix from the template.
 */
export const metadata: Metadata = {
  metadataBase: safeMetadataBase(),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  openGraph: openGraphFor({ title: SITE_NAME, description: SITE_DESCRIPTION }),
  twitter: { card: 'summary_large_image', title: SITE_NAME, description: SITE_DESCRIPTION },
};

/**
 * lang="fa" + dir="rtl" at the document root -- the single structural
 * decision that makes every logical CSS property in globals.css resolve
 * correctly, and the reason no component needs its own RTL branching.
 * BeauClick is Persian-only by design (V3_FRONTEND_ARCHITECTURE.md §7:
 * no i18n framework, since there is no language switcher in the product).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /*
      The two font variables are declared on <html> rather than on <body> so
      that anything rendered into a portal -- a dialog, the mobile sheet --
      inherits them too. `--bc-font-family` in tokens.css resolves against
      `--bc-font-vazir`, so nothing below this line needs to know a font name.
    */
    <html lang="fa" dir="rtl" className={`${vazir.variable} ${anjoman.variable} ${peyda.variable}`}>
      <body>
        <a className="bc-visually-hidden bc-skip-link" href="#main">
          پرش به محتوای اصلی
        </a>
        <AuthProvider>
          {/* Inside AuthProvider: the unread count is session-scoped and
              resets when the session does. */}
          <UnreadProvider>
            <AppShell>{children}</AppShell>
          </UnreadProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
