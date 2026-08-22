'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { useUnread } from '@/lib/unread-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Card, LoadingState } from '@/components/ui';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationPreferences,
  updateNotificationPreferences,
  type NotificationItem,
  type NotificationPreference,
} from '@/lib/phase3-api';

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
  const [showPreferences, setShowPreferences] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, prefs] = await Promise.all([listNotifications(api), notificationPreferences(api)]);
      setItems(list.data?.items ?? []);
      setUnread(list.data?.unreadCount ?? 0);
      setPreferences(prefs.data?.preferences ?? []);
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

  if (loading) return <LoadingState label="در حال بارگذاری اعلان‌ها…" />;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 24, marginBlockEnd: 4 }}>
          اعلان‌ها{' '}
          {unread > 0 && (
            <span
              aria-label={`${toPersianDigits(unread)} اعلان خوانده‌نشده`}
              style={{
                fontSize: 14,
                fontWeight: 700,
                padding: '2px 10px',
                borderRadius: 999,
                background: 'var(--bc-color-primary)',
                color: 'var(--bc-color-surface)',
              }}
            >
              {toPersianDigits(unread)}
            </span>
          )}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setShowPreferences((v) => !v)} aria-expanded={showPreferences} style={linkButton}>
            تنظیمات
          </button>
          {unread > 0 && (
            <button type="button" onClick={() => void readAll()} style={linkButton}>
              علامت‌گذاری همه به‌عنوان خوانده‌شده
            </button>
          )}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {showPreferences && (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>دریافت اعلان‌ها</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            {preferences.map((pref) => (
              <li key={pref.category} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
                <input
                  id={`pref-${pref.category}`}
                  type="checkbox"
                  checked={pref.enabled}
                  disabled={pref.mandatory}
                  onChange={(e) => void togglePreference(pref.category, e.target.checked)}
                  style={{ width: 20, height: 20 }}
                />
                <label htmlFor={`pref-${pref.category}`} style={{ fontSize: 14 }}>
                  {CATEGORY_LABELS[pref.category] ?? pref.category}
                  {pref.mandatory && (
                    // Explained, not merely greyed out: a disabled control with
                    // no reason reads as a bug.
                    <span style={{ color: 'var(--bc-color-ink-faint)', fontSize: 12 }}>
                      {' '}
                      — همیشه فعال (پیام‌های ضروری)
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {items.length === 0 ? (
        <Card>
          <p style={{ margin: 0 }}>هنوز اعلانی ندارید.</p>
        </Card>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <article
                  // The unread state is announced, not only coloured -- a
                  // colour-only distinction is invisible to a screen reader
                  // and to anyone who cannot distinguish the two shades.
                  aria-label={item.read ? undefined : 'خوانده‌نشده'}
                  style={{
                    borderInlineStart: item.read ? 'none' : '3px solid var(--bc-color-primary)',
                    paddingInlineStart: item.read ? 0 : 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: 16, margin: 0 }}>
                      {item.title}
                      {!item.read && <span style={{ color: 'var(--bc-color-primary)' }}> •</span>}
                    </h2>
                    <span style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                      {formatFullJalaliDate(new Date(item.createdAt))}
                    </span>
                  </div>
                  {item.body && <p style={{ margin: '8px 0 0', fontSize: 14 }}>{item.body}</p>}
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    {CATEGORY_LABELS[item.category] ?? item.category}
                  </p>

                  <div style={{ display: 'flex', gap: 8, marginBlockStart: 10, flexWrap: 'wrap' }}>
                    {item.deepLink && (
                      <Link href={item.deepLink} onClick={() => void readOne(item.id)} style={{ ...linkButton, textDecoration: 'none' }}>
                        مشاهده
                      </Link>
                    )}
                    {!item.read && (
                      <button type="button" onClick={() => void readOne(item.id)} style={linkButton}>
                        خوانده شد
                      </button>
                    )}
                  </div>
                </article>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const linkButton: React.CSSProperties = {
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  padding: '10px 14px',
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 'var(--bc-radius-button)',
  border: '1px solid var(--bc-color-line)',
  background: 'transparent',
  color: 'var(--bc-color-ink)',
  cursor: 'pointer',
};
