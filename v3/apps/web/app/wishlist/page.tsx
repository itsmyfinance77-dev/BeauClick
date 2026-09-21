'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatZonedFullDate } from '@beauclick/persian-utils';
import { wishlistTargetKey, type WishlistItemView } from '@beauclick/wishlist-contract';
import { ProtectedRoute } from '@/components/protected-route';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { EmptyState, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { bookingApi } from '@/lib/booking-api';
import { removeFromWishlist } from '@/lib/phase3-api';
import { wishlistItems } from '@/lib/wishlist-api';
import styles from './wishlist.module.css';

/**
 * The wishlist — `38_WISHLIST.md`.
 *
 * A saved item is `{ targetType, targetId, savedAt, state }` and nothing more:
 * no name, price or picture is stored, and there is no batch route that resolves
 * a page of ids (`WISHLIST-HYDRATION-BATCH`). So a professional's name is read
 * per row, on demand, from the public profile route, and a row that cannot be
 * named still works — it links to the profile and can be removed. A saved
 * SERVICE has no reverse lookup to its professional at all
 * (`WISHLIST-SERVICE-PARENT-LOOKUP`), so it is shown as a saved service, with a
 * remove control and nothing invented around it.
 *
 * Privacy, as the spec draws it: no count of items, no "N people saved this",
 * no popularity, no ranking. There is no field that could carry one.
 */
export default function WishlistPage() {
  return (
    <ProtectedRoute>
      <Wishlist />
    </ProtectedRoute>
  );
}

function Wishlist() {
  const { api } = useAuth();
  const [items, setItems] = useState<WishlistItemView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await wishlistItems(api);
      setItems([...(res.data?.items ?? [])]);
      setNextCursor(res.data?.nextCursor ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست علاقه‌مندی‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await wishlistItems(api, nextCursor);
      // A failed page two never touches page one: this only appends on success.
      // Keyed by the target, so an item that moved between pages appears once.
      setItems((current) => {
        const seen = new Set(current.map((i) => wishlistTargetKey(i)));
        return [...current, ...(res.data?.items ?? []).filter((i) => !seen.has(wishlistTargetKey(i)))];
      });
      setNextCursor(res.data?.nextCursor ?? null);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'صفحهٔ بعد بارگذاری نشد.');
    } finally {
      setLoadingMore(false);
    }
  }

  function removed(item: WishlistItemView) {
    const key = wishlistTargetKey(item);
    setItems((current) => current.filter((i) => wishlistTargetKey(i) !== key));
  }

  const empty = loaded && items.length === 0 && !nextCursor;

  return (
    <div className={styles.page}>
      <PageHeader title="علاقه‌مندی‌ها" subtitle="متخصص‌ها و خدمت‌هایی که ذخیره کرده‌اید. فقط خودتان این فهرست را می‌بینید." />

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری علاقه‌مندی‌ها…" lines={4} />
      ) : error && !loaded ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : empty ? (
        <EmptyState
          message="فهرست علاقه‌مندی‌های شما خالی است."
          action={
            <Link href="/search" className={styles.nameLink}>
              جست‌وجوی متخصص
            </Link>
          }
        />
      ) : (
        <>
          <ul className={styles.list}>
            {items.map((item) => (
              <WishlistRow key={wishlistTargetKey(item)} item={item} onRemoved={() => removed(item)} />
            ))}
          </ul>
          {nextCursor ? (
            <div className={styles.more}>
              {moreError ? (
                <p role="alert" className={styles.moreError}>
                  {moreError}
                </p>
              ) : null}
              <Button type="button" variant="ghost" inline loading={loadingMore} onClick={() => void loadMore()}>
                {moreError ? 'تلاش دوباره' : 'بیشتر'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- a row

type Name = { status: 'idle' } | { status: 'ready'; value: string } | { status: 'failed' };

function WishlistRow({ item, onRemoved }: { item: WishlistItemView; onRemoved: () => void }) {
  const { api } = useAuth();
  const [name, setName] = useState<Name>({ status: 'idle' });
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unavailable = item.state !== 'available';
  const isProfessional = item.targetType === 'professional';

  // Only an AVAILABLE professional is looked up: an unavailable one must show no
  // name at all (and its profile would refuse), and a service has no route that
  // names its professional.
  useEffect(() => {
    if (unavailable || !isProfessional) return;
    let cancelled = false;
    bookingApi
      .getProvider(api, item.targetId)
      .then((res) => {
        if (!cancelled) setName(res.data?.displayName ? { status: 'ready', value: res.data.displayName } : { status: 'failed' });
      })
      .catch(() => {
        if (!cancelled) setName({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, item.targetId, unavailable, isProfessional]);

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await removeFromWishlist(api, item.targetType, item.targetId);
      onRemoved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'حذف انجام نشد. دوباره تلاش کنید.');
      setRemoving(false);
    }
  }

  const label = unavailable
    ? 'مورد ذخیره‌شده'
    : isProfessional
      ? name.status === 'ready'
        ? name.value
        : 'متخصص ذخیره‌شده'
      : 'خدمت ذخیره‌شده';

  return (
    <li className={`${styles.item} ${unavailable ? styles.gone : ''}`} data-target={wishlistTargetKey(item)} data-state={item.state}>
      <div className={styles.what}>
        {unavailable ? (
          // A neutral tombstone. Deleted, suspended and revoked are one value on
          // the server with no cause anywhere that could carry one, so the row
          // says one thing for all of them.
          <p className={styles.goneText}>این مورد دیگر در دسترس نیست.</p>
        ) : (
          <>
            {/* The kind is said once: a fallback title («متخصص ذخیره‌شده», «خدمت ذخیره‌شده»)
                already names it, so the small label only appears above a real name. */}
            {isProfessional && name.status === 'ready' ? <p className={styles.kind}>متخصص</p> : null}
            <p className={styles.name}>
              {isProfessional ? (
                <Link href={`/providers/${item.targetId}`} className={styles.nameLink}>
                  {label}
                </Link>
              ) : (
                label
              )}
            </p>
            <p className={styles.savedAt}>ذخیره‌شده در {formatZonedFullDate(new Date(item.savedAt))}</p>
          </>
        )}
        {error ? (
          <p role="alert" className={styles.rowError}>
            {error}
          </p>
        ) : null}
      </div>
      <div className={styles.remove}>
        <Button
          type="button"
          variant="ghost"
          inline
          loading={removing}
          aria-label={unavailable ? 'حذف این مورد از علاقه‌مندی‌ها' : `حذف ${label} از علاقه‌مندی‌ها`}
          onClick={() => void remove()}
        >
          حذف
        </Button>
      </div>
    </li>
  );
}
