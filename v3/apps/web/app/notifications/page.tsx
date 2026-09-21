'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { useUnread } from '@/lib/unread-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, type BadgeTone } from '@/components/kit';
import { notificationHref } from '@/lib/notification-link';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationPreferences,
  updateNotificationPreferences,
  type NotificationItem,
  type NotificationPreference,
} from '@/lib/phase3-api';
import styles from './notifications.module.css';

const CATEGORY_LABELS: Record<string, string> = {
  booking: 'رزرو',
  payment: 'پرداخت',
  reminder: 'یادآوری',
  waitlist: 'لیست انتظار',
  rebooking: 'رزرو مجدد',
  retention: 'پیشنهادها',
  referral: 'معرفی دوستان',
  loyalty: 'باشگاه مشتریان',
};

/**
 * A soft tint per category, so a list can be scanned by kind. The label is
 * always printed as well — the tint is for those who can see it, not the only
 * carrier of the category.
 */
const CATEGORY_TONE: Record<string, BadgeTone> = {
  booking: 'primary',
  payment: 'success',
  reminder: 'warning',
  waitlist: 'warning',
  rebooking: 'neutral',
  retention: 'neutral',
  referral: 'primary',
  loyalty: 'primary',
};

export default function NotificationsPage() {
  return (
    <ProtectedRoute>
      <NotificationCenter />
    </ProtectedRoute>
  );
}

function NotificationCenter() {
  const { api } = useAuth();
  // The badge count lives in a shared context so the header updates with the
  // list -- they describe the same thing and must never disagree.
  const { unreadCount: unread, setUnreadCount: setUnread } = useUnread();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Distinguishes "the server said you have no notifications" from "we never
  // heard back" -- both leave `items` empty, and only the first of them may
  // show the empty state.
  const [loaded, setLoaded] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, prefs] = await Promise.all([listNotifications(api), notificationPreferences(api)]);
      setItems(list.data?.items ?? []);
      setUnread(list.data?.unreadCount ?? 0);
      setPreferences(prefs.data?.preferences ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اعلان‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const readOne = async (id: string) => {
    // Optimistic: the row is marked read locally before the request settles,
    // because the customer has already seen it and a spinner on a read
    // receipt would be pure friction. The count is reconciled from the
    // server's own answer immediately after.
    setItems((current) => current.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      const res = await markNotificationRead(api, id);
      setUnread(res.data?.unreadCount ?? 0);
    } catch {
      await load();
    }
  };

  const readAll = async () => {
    try {
      const res = await markAllNotificationsRead(api);
      setUnread(res.data?.unreadCount ?? 0);
      setItems((current) => current.map((n) => ({ ...n, read: true })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'عملیات انجام نشد.');
    }
  };

  const togglePreference = async (category: string, enabled: boolean) => {
    try {
      const res = await updateNotificationPreferences(api, { [category]: enabled });
      // The server's response is the TRUE state, not an echo -- attempting to
      // disable a mandatory category comes back still enabled, and the UI
      // shows that rather than a value that did not take effect.
      setPreferences(res.data?.preferences ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ذخیره تنظیمات انجام نشد.');
    }
  };

  if (loading) return <LoadingState label="در حال بارگذاری اعلان‌ها…" lines={4} />;
  if (!loaded) return <ErrorState message={error ?? 'اعلان‌ها بارگذاری نشد.'} onRetry={() => void load()} />;

  return (
    <section>
      <div className={styles.head}>
        <h1 className={styles.title}>
          اعلان‌ها
          {unread > 0 && (
            <span className={styles.count} aria-label={`${toPersianDigits(unread)} اعلان خوانده‌نشده`}>
              {toPersianDigits(unread)}
            </span>
          )}
        </h1>
        <button
          type="button"
          className={styles.control}
          onClick={() => setShowPreferences((v) => !v)}
          aria-expanded={showPreferences}
        >
          تنظیمات
        </button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {showPreferences && (
        <div className={styles.prefs}>
          <h2 className={styles.prefsTitle}>دریافت اعلان‌ها</h2>
          <ul className={styles.prefList}>
            {preferences.map((pref) => (
              <li key={pref.category} className={styles.pref}>
                <input
                  id={`pref-${pref.category}`}
                  type="checkbox"
                  checked={pref.enabled}
                  disabled={pref.mandatory}
                  onChange={(e) => void togglePreference(pref.category, e.target.checked)}
                />
                <label htmlFor={`pref-${pref.category}`} className={styles.prefLabel}>
                  {CATEGORY_LABELS[pref.category] ?? pref.category}
                  {pref.mandatory && (
                    // Explained, not merely greyed out: a disabled control with
                    // no reason reads as a bug.
                    <span className={styles.prefReason}> — همیشه فعال (پیام‌های ضروری)</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState message="هنوز اعلانی ندارید." />
      ) : (
        <>
          {/* "Read all" directly above the list it acts on (18_NOTIFICATIONS.md). */}
          <div className={styles.toolbar}>
            <p className={styles.toolbarText}>
              {unread > 0 ? `${toPersianDigits(unread)} اعلان خوانده‌نشده` : 'همهٔ اعلان‌ها خوانده شده‌اند.'}
            </p>
            {unread > 0 && (
              <button type="button" className={styles.control} onClick={() => void readAll()}>
                علامت‌گذاری همه به‌عنوان خوانده‌شده
              </button>
            )}
          </div>

          <ul className={styles.list}>
            {items.map((item) => {
              // Only a link to a page that exists. See lib/notification-link.ts.
              const href = notificationHref(item.deepLink);
              return (
                <li key={item.id}>
                  <article
                    // The unread state is announced, not only coloured -- a
                    // colour-only distinction is invisible to a screen reader
                    // and to anyone who cannot distinguish the two shades.
                    aria-label={item.read ? undefined : 'خوانده‌نشده'}
                    className={`${styles.item} ${item.read ? '' : styles.unread}`}
                    data-notification={item.id}
                  >
                    <div className={styles.itemHead}>
                      <h2 className={styles.itemTitle}>
                        {!item.read && <span className={styles.dot} aria-hidden="true" />}
                        {item.title}
                      </h2>
                      <span className={styles.when}>{formatFullJalaliDate(new Date(item.createdAt))}</span>
                    </div>
                    {item.body && <p className={styles.body}>{item.body}</p>}
                    <div className={styles.meta}>
                      <Badge tone={CATEGORY_TONE[item.category] ?? 'neutral'}>
                        {CATEGORY_LABELS[item.category] ?? item.category}
                      </Badge>
                    </div>

                    {(href || !item.read) && (
                      <div className={styles.actions}>
                        {href && (
                          <Link href={href} onClick={() => void readOne(item.id)} className={styles.control}>
                            مشاهده
                          </Link>
                        )}
                        {!item.read && (
                          <button type="button" className={styles.control} onClick={() => void readOne(item.id)}>
                            خوانده شد
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
