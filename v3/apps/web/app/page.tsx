import Link from 'next/link';
import { Card } from '@/components/ui';

const ENTRY_LINK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  // accessibility: comfortable touch target on mobile -- matches Button's own minHeight
  minHeight: 44,
  padding: '12px 20px',
} as const;

/**
 * Server-rendered by default (no 'use client') -- the SSR half of
 * ADR-012's rendering split.
 *
 * This page shipped in v3.0.0 still carrying its Phase 1 scaffold copy:
 * "این صفحه بخشی از بنیان فنی فاز ۱ است؛ صفحات محصول در فازهای بعدی ساخته
 * می‌شوند." That is an internal engineering status note, written for this
 * team, displayed to every visitor on the product's front door -- it tells a
 * customer the product is not built yet. Removed.
 *
 * What replaces it is deliberately modest: the two things a signed-out
 * visitor can actually DO today (search, browse professionals) plus signing
 * in, rather than invented marketing copy. A real landing page is a design
 * deliverable, and is recorded as an open product gap rather than improvised
 * here.
 */
export default function HomePage() {
  return (
    <Card>
      <h1>BeauClick</h1>
      <p style={{ color: 'var(--bc-color-ink-soft)' }}>
        مارکت‌پلیس هوشمند زیبایی — رزرو آنلاین خدمات زیبایی از متخصص‌های تأییدشده.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBlockStart: 8 }}>
        <Link href="/search" style={ENTRY_LINK_STYLE}>
          جست‌وجوی متخصص
        </Link>
        <Link href="/providers" style={ENTRY_LINK_STYLE}>
          مشاهده متخصص‌ها
        </Link>
        <Link href="/auth" style={ENTRY_LINK_STYLE}>
          ورود با شماره موبایل
        </Link>
      </div>
    </Card>
  );
}
