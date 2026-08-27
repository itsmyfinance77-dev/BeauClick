'use client';

import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from './ui';
import { EmptyState, TextLink } from './kit';
import { useProProfile } from '@/lib/pro-context';
import type { MyProviderProfile } from '@/lib/pro-api';

/**
 * Renders its children only when a professional profile genuinely exists.
 *
 * Every `/pro` screen except the profile editor is meaningless without one —
 * there is no catalogue to manage, no availability to publish, no bookings to
 * see. Rather than each of the six screens re-deriving that, they wrap in
 * this and receive the profile as an argument.
 *
 * The four-state discipline from `ProProvider` is preserved intact here,
 * because collapsing it is exactly the bug class v3.0.1 fixed five times:
 *
 *   loading  ->  a loading state, announced (`role="status"`)
 *   error    ->  ErrorState WITH a retry. We do not know whether a profile
 *                exists, so we assert nothing about it.
 *   none     ->  an EMPTY state that says "you have not created one" and
 *                links to the editor. This is an assertion, and we are only
 *                entitled to make it because the server answered.
 *   ready    ->  children
 *
 * Note what is deliberately absent from the `error` branch: any invitation to
 * create a profile. Offering "create your professional profile" after a failed
 * load is how QA-07 shipped — the user would be pushed toward a POST that
 * correctly 409s against the profile they already have and cannot currently see.
 */
export function ProGuard({ children }: { children: (profile: MyProviderProfile) => ReactNode }) {
  const { state, profile, error, reload } = useProProfile();

  if (state === 'loading') return <LoadingState label="در حال بارگذاری پروفایل متخصص…" />;

  if (state === 'error') {
    return <ErrorState message={error ?? 'پروفایل متخصص بارگذاری نشد.'} onRetry={() => void reload()} />;
  }

  if (state === 'none' || !profile) {
    return (
      <EmptyState
        message="هنوز پروفایل متخصص نساخته‌اید. برای مدیریت خدمات، زمان‌های آزاد و رزروها، ابتدا پروفایل خود را بسازید."
        action={<TextLink href="/pro/profile">ساخت پروفایل متخصص</TextLink>}
      />
    );
  }

  return <>{children(profile)}</>;
}
