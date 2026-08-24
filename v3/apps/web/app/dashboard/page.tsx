'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { formatFullJalaliDate } from '@beauclick/persian-utils';

interface MeResponse {
  id: string;
  phone: string;
  displayName: string | null;
  roles: string[];
  capabilities: string[];
}

/**
 * A protected page that makes a real authenticated API call (GET /v1/me)
 * -- the smallest thing that proves the whole chain end to end: token
 * storage -> Authorization header -> API JwtAuthGuard -> real database ->
 * rendered in RTL Persian. Product dashboards are later-phase scope.
 */
function DashboardContent() {
  const { api } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Extracted from an inline effect so the error state has something to
  // retry. The cancelled-flag guard is kept: it stops a response that
  // arrives after unmount from setting state.
  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    api
      .get<MeResponse>('/v1/me')
      .then((res) => {
        if (!cancelled) setMe(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => load(), [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!me) return <LoadingState />;

  return (
    <Card>
      <h1 style={{ fontSize: 24 }}>داشبورد</h1>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 14 }}>
        <dt style={{ color: 'var(--bc-color-ink-faint)' }}>شماره موبایل</dt>
        <dd style={{ margin: 0 }}>{me.phone}</dd>

        <dt style={{ color: 'var(--bc-color-ink-faint)' }}>نقش‌ها</dt>
        <dd style={{ margin: 0 }}>{me.roles.join('، ')}</dd>

        <dt style={{ color: 'var(--bc-color-ink-faint)' }}>امروز</dt>
        <dd style={{ margin: 0 }}>{formatFullJalaliDate(new Date())}</dd>
      </dl>
    </Card>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
