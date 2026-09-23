'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Alert, Card, LoadingState } from '@/components/ui';
import { bookingApi, type ProviderSummary } from '@/lib/booking-api';
import styles from './providers.module.css';

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
        <h1 className={styles.emptyTitle}>متخصص‌ها</h1>
        <p className={styles.emptyText}>هنوز متخصصی ثبت نشده است.</p>
      </Card>
    );
  }

  return (
    <section>
      <h1 className={styles.title}>متخصص‌ها</h1>

      <ul className={styles.list}>
        {providers.map((provider) => (
          <li key={provider.id}>
            <Link href={`/providers/${provider.id}`} className={styles.cardLink}>
              <Card>
                <div className={styles.cardRow}>
                  <div>
                    <h2 className={styles.providerName}>{provider.displayName}</h2>
                    {provider.bio ? <p className={styles.providerBio}>{provider.bio}</p> : null}
                    {provider.specialties.length > 0 ? (
                      <ul className={styles.specialtyList}>
                        {provider.specialties.map((s) => (
                          <li key={s.id} className={styles.specialtyChip}>
                            {s.name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <span aria-hidden="true" className={styles.chevron}>
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
