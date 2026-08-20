'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Alert, Card, LoadingState } from '@/components/ui';
import { bookingApi, type ProviderSummary } from '@/lib/booking-api';

/**
 * The entry point to the booking flow: the professionals a customer can
 * book with.
 *
 * Deliberately the minimum needed to REACH the booking flow, not the V3
 * marketplace. Search, filtering, ranking, and rich profiles are the Search
 * phase's scope; building them here would pull a later phase forward under
 * the cover of "the booking flow needs a list".
 *
 * Public: no session required to browse.
 */
export default function ProvidersPage() {
  const { api } = useAuth();
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bookingApi
      .listProviders(api)
      .then((res) => {
        if (!cancelled) setProviders(res.data ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!providers) return <LoadingState label="در حال بارگذاری متخصص‌ها…" />;

  if (providers.length === 0) {
    return (
      <Card>
        <h1 style={{ fontSize: 22, marginBlockEnd: 8 }}>متخصص‌ها</h1>
        <p style={{ color: 'var(--bc-color-ink-soft)' }}>هنوز متخصصی ثبت نشده است.</p>
      </Card>
    );
  }

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 16 }}>متخصص‌ها</h1>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
        {providers.map((provider) => (
          <li key={provider.id}>
            <Link
              href={`/providers/${provider.id}`}
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ fontSize: 18, marginBlockEnd: 4 }}>{provider.displayName}</h2>
                    {provider.bio ? (
                      <p style={{ fontSize: 14, color: 'var(--bc-color-ink-soft)', margin: 0 }}>{provider.bio}</p>
                    ) : null}
                    {provider.specialties.length > 0 ? (
                      <ul
                        style={{
                          listStyle: 'none',
                          padding: 0,
                          margin: '8px 0 0',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 'var(--bc-spacing-chip-gap)',
                        }}
                      >
                        {provider.specialties.map((s) => (
                          <li
                            key={s.id}
                            style={{
                              fontSize: 12,
                              padding: '4px 10px',
                              borderRadius: 'var(--bc-radius-pill)',
                              background: 'var(--bc-color-surface-tint)',
                              color: 'var(--bc-color-ink-soft)',
                            }}
                          >
                            {s.name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <span aria-hidden="true" style={{ color: 'var(--bc-color-ink-faint)', fontSize: 20 }}>
                    ‹
                  </span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
