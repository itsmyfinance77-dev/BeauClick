'use client';

import { useCallback, useEffect, useState } from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { deviceTitle } from '@/lib/device-label';
import { relativePastLabel } from '@/lib/relative-time';
import { listSessions, revokeSession, type DeviceSession } from '@/lib/sessions-api';
import styles from './devices.module.css';

/**
 * Devices and sessions — `30_DEVICE_SESSIONS.md`.
 *
 * See the devices signed in to the account, and sign one or all of the others
 * out, without any risk of signing out the device in your hand.
 *
 * Three things from the spec and the API that shape it:
 *
 *  - `current` is real, and legitimately `false` on EVERY row (a token minted
 *    before the claim existed). That is not an error and the page never assumes
 *    exactly one row is marked: with none marked it says which-is-yours is not
 *    known yet, and refuses the bulk action rather than guess.
 *  - "Sign out my other devices" is NOT `POST /logout-all-devices`. That route
 *    revokes every session including the current one and clears the cookies. So
 *    the bulk action revokes each other session by its own id.
 *  - The device in your hand has no sign-out control here: signing out of it is
 *    the ordinary sign-out.
 */
export default function DevicesPage() {
  return (
    <ProtectedRoute>
      <Devices />
    </ProtectedRoute>
  );
}

function Devices() {
  const { api } = useAuth();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');

  const [bulkDialog, setBulkDialog] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listSessions(api);
      setSessions(res.data ?? []);
      setNow(Date.now());
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست دستگاه‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // A signed-out device stays in the list as a revoked tip; it is not a device
  // that can be signed out any more, so it is not shown. The device in your
  // hand comes first, then the most recently used.
  const devices = sessions
    .filter((s) => !s.revoked)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        new Date(b.lastUsedAt ?? b.createdAt).getTime() - new Date(a.lastUsedAt ?? a.createdAt).getTime(),
    );
  const currentKnown = devices.some((d) => d.current);
  const others = devices.filter((d) => !d.current);

  async function signOut(device: DeviceSession) {
    setRevoking(device.id);
    setRowErrors((e) => ({ ...e, [device.id]: '' }));
    try {
      await revokeSession(api, device.id);
      setSessions((current) => current.filter((s) => s.id !== device.id));
      setConfirming(null);
      setAnnouncement(`از دستگاه ${deviceTitle(device.userAgent)} خارج شد.`);
    } catch (err) {
      // The server says one thing whether the device is someone else's, gone, or never existed.
      setRowErrors((e) => ({ ...e, [device.id]: err instanceof Error && err.message ? err.message : 'خروج انجام نشد. دوباره تلاش کنید.' }));
      setConfirming(null);
    } finally {
      setRevoking(null);
    }
  }

  async function signOutOthers() {
    setBulkBusy(true);
    setBulkMessage(null);
    setAnnouncement('');
    let failed = 0;
    // One at a time, each by its own id: there is no "all except this one" route.
    for (const device of others) {
      try {
        await revokeSession(api, device.id);
      } catch {
        failed += 1;
      }
    }
    setBulkDialog(false);
    setBulkBusy(false);
    await load();
    if (failed > 0) {
      setBulkMessage(`از ${failed === 1 ? 'یک دستگاه' : `${failed} دستگاه`} خارج نشد. دوباره تلاش کنید.`);
    } else {
      setAnnouncement('از همهٔ دستگاه‌های دیگر خارج شد.');
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="دستگاه‌ها و نشست‌ها" subtitle="دستگاه‌هایی که با حساب شما وارد شده‌اند." />

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری دستگاه‌ها…" lines={4} />
      ) : error && !loaded ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <>
          {!currentKnown ? (
            // Not an error: a token minted before this was tracked. No row is
            // marked, because guessing one would risk signing you out of the
            // device you are holding.
            <p role="status" className={styles.notice}>
              این‌که کدام دستگاه شماست هنوز مشخص نشده؛ با ورودِ بعدی مشخص می‌شود.
            </p>
          ) : null}

          <ul className={styles.list}>
            {devices.map((device) => {
              const title = deviceTitle(device.userAgent);
              const lastUsed = relativePastLabel(device.lastUsedAt ?? device.createdAt, now);
              return (
                <li
                  key={device.id}
                  role="group"
                  aria-label={`دستگاه، ${title}، آخرین استفاده ${lastUsed}`}
                  data-device={device.id}
                  className={`${styles.device} ${device.current ? styles.current : ''}`}
                >
                  <div className={styles.what}>
                    <div className={styles.titleRow}>
                      <p className={styles.title}>{title}</p>
                      {device.current ? <Badge tone="primary">این دستگاه</Badge> : null}
                    </div>
                    {device.deviceLabel ? <p className={styles.label}>{device.deviceLabel}</p> : null}
                    <p className={styles.times}>
                      ورود: {relativePastLabel(device.createdAt, now)} · آخرین استفاده: {lastUsed}
                    </p>
                  </div>

                  <div className={styles.controls}>
                    {device.current ? (
                      <p className={styles.hint}>این دستگاهی است که اکنون استفاده می‌کنید. برای خروج از آن، «خروج از حساب» را بزنید.</p>
                    ) : confirming === device.id ? (
                      <>
                        <p className={styles.confirmText}>
                          {currentKnown
                            ? 'از این دستگاه خارج شود؟ باید دوباره وارد شود.'
                            : 'از این دستگاه خارج شود؟ اگر این دستگاه خودِ شماست، از حساب خارج می‌شوید.'}
                        </p>
                        <div className={styles.confirmButtons}>
                          <Button type="button" variant="danger" inline loading={revoking === device.id} onClick={() => void signOut(device)}>
                            بله، خارج شود
                          </Button>
                          <Button type="button" variant="ghost" inline disabled={revoking === device.id} onClick={() => setConfirming(null)}>
                            انصراف
                          </Button>
                        </div>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        inline
                        aria-label={`خروج از دستگاه ${title}`}
                        onClick={() => setConfirming(device.id)}
                      >
                        خروج از این دستگاه
                      </Button>
                    )}
                    {rowErrors[device.id] ? (
                      <p role="alert" className={styles.rowError}>
                        {rowErrors[device.id]}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className={styles.bulk}>
            <Button
              type="button"
              variant="ghost"
              disabled={!currentKnown || others.length === 0}
              aria-describedby="devices-bulk-hint"
              onClick={() => setBulkDialog(true)}
            >
              خروج از همهٔ دستگاه‌های دیگر
            </Button>
            <p id="devices-bulk-hint" className={styles.hint}>
              {!currentKnown
                ? 'تا مشخص نشود کدام دستگاه شماست، خروج گروهی ممکن نیست.'
                : others.length === 0
                  ? 'دستگاه دیگری با حساب شما وارد نشده است.'
                  : 'شما از این دستگاه خارج نمی‌شوید.'}
            </p>
            {bulkMessage ? (
              <p role="alert" className={styles.rowError}>
                {bulkMessage}
              </p>
            ) : null}
          </div>

          <p className={styles.announce} role="status" aria-live="polite">
            {announcement}
          </p>
        </>
      )}

      <ConfirmDialog
        open={bulkDialog}
        title="خروج از همهٔ دستگاه‌های دیگر"
        tone="danger"
        confirmLabel="خروج از دستگاه‌های دیگر"
        busy={bulkBusy}
        onConfirm={() => void signOutOthers()}
        onCancel={() => setBulkDialog(false)}
        body={
          <p className={styles.dialogText}>
            شما از حساب خارج نمی‌شوید. فقط دستگاه‌های دیگر خارج می‌شوند و برای استفاده دوباره باید وارد شوند.
          </p>
        }
      />
    </div>
  );
}
