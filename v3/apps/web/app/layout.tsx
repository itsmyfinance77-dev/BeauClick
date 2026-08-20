import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'BeauClick',
  description: 'مارکت‌پلیس هوشمند زیبایی',
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
    <html lang="fa" dir="rtl">
      <body>
        <a className="bc-visually-hidden bc-skip-link" href="#main">
          پرش به محتوای اصلی
        </a>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
