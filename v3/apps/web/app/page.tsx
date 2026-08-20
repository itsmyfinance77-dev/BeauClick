import Link from 'next/link';
import { Card } from '@/components/ui';

/**
 * Server-rendered by default (no 'use client') -- the SSR half of
 * ADR-012's rendering split. Real product/marketplace pages are later-phase
 * scope; this exists to prove the shell, tokens, and RTL layout render.
 */
export default function HomePage() {
  return (
    <Card>
      <h1>BeauClick</h1>
      <p style={{ color: 'var(--bc-color-ink-soft)' }}>
        مارکت‌پلیس هوشمند زیبایی — بنیان نسخه ۳
      </p>
      <p style={{ fontSize: 14, color: 'var(--bc-color-ink-faint)' }}>
        این صفحه بخشی از بنیان فنی فاز ۱ است؛ صفحات محصول در فازهای بعدی ساخته می‌شوند.
      </p>
      <Link href="/auth" style={{ fontWeight: 600 }}>
        ورود با شماره موبایل
      </Link>
    </Card>
  );
}
