'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { LoadingState } from './ui';

/**
 * Client-side protected-route guard for the Phase 1 foundation.
 *
 * IMPORTANT, and deliberately stated rather than left implied: this is a
 * UX guard, NOT a security boundary. It stops an unauthenticated user
 * from seeing an empty/broken screen; it does not protect data. Every
 * piece of protected data is protected by the API's own JwtAuthGuard +
 * OwnershipGuard, which re-verify on every single request regardless of
 * what the client believes. A user who bypasses this component sees an
 * empty page, not someone else's data.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/auth');
  }, [status, router]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'unauthenticated') return <LoadingState label="در حال انتقال به صفحه ورود…" />;

  return <>{children}</>;
}
