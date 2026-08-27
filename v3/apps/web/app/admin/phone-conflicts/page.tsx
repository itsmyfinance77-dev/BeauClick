'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { phoneConflicts, resolvePhoneConflict, type PhoneConflict } from '@/lib/admin-api';

/**
 * Phone-conflict review (GAP-20).
 *
 * `identity.phone_conflicts` has collected rows since Phase 1 with
 * `resolved_at` write-never -- the column existed and nothing could ever mark
 * one handled. V2 had the same gap (AUTH-10).
 *
 * WHAT "RESOLVE" MEANS, said on the screen as well as in the code: it records
 * that a human looked. It does not merge accounts or touch either identity.
 * V3_SECURITY_MODEL.md §1's rule is "never silently merge identities on
 * ambiguity", and a button that merged them would be that silent merge with a
 * slower trigger.
 */
export default function AdminPhoneConflictsPage() {
  const { api } = useAuth();

  const [items, setItems] = useState<PhoneConflict[]>([]);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<PhoneConflict | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await phoneConflicts(api, { includeResolved });
      setItems(res.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست تعارض‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, includeResolved]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await resolvePhoneConflict(api, pending.id, reason.trim());
      setPending(null);
      setReason('');
      await load();
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : 'ثبت رفع تعارض انجام نشد.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="تعارض شماره موبایل"
        subtitle="مواردی که هنگام ثبت‌نام هم‌زمان، یک شماره برای دو حساب ثبت شده است."
        action={
          <Button type="button" variant="ghost" inline onClick={() => setIncludeResolved((v) => !v)}>
            {includeResolved ? 'فقط بررسی‌نشده‌ها' : 'نمایش بررسی‌شده‌ها'}
          </Button>
        }
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <Alert tone="success">
        «بررسی شد» فقط ثبت می‌کند که یک نفر این مورد را دیده است. هیچ حسابی ادغام یا تغییر داده نمی‌شود.
      </Alert>

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" />
      ) : loaded && items.length === 0 ? (
        <EmptyState
          message={includeResolved ? 'هیچ تعارضی ثبت نشده است.' : 'تعارض بررسی‌نشده‌ای وجود ندارد.'}
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {items.map((conflict) => (
            <Card key={conflict.id}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 'var(--bc-spacing-chip-gap)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 700, direction: 'ltr', textAlign: 'start' }}>
                    {toPersianDigits(conflict.phone)}
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                    ثبت: {formatZonedDateTime(new Date(conflict.createdAt))}
                  </p>
                  {/* The other account's id and nothing more. Joining the user
                      table here would turn a narrow operational queue into a
                      general-purpose lookup of arbitrary accounts. */}
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    حساب موجود:{' '}
                    <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                      {conflict.existingUserId.slice(0, 8)}
                    </span>
                  </p>
                  {conflict.note ? (
                    <p style={{ margin: '8px 0 0', fontSize: 13 }}>{conflict.note}</p>
                  ) : null}
                </div>
                {conflict.resolvedAt ? (
                  <Badge tone="success">بررسی شده</Badge>
                ) : (
                  <Badge tone="warning">بررسی‌نشده</Badge>
                )}
              </div>

              {!conflict.resolvedAt ? (
                <div style={{ marginBlockStart: 16 }}>
                  <Button type="button" inline onClick={() => setPending(conflict)}>
                    ثبت بررسی
                  </Button>
                </div>
              ) : (
                <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                  بررسی‌شده در {formatZonedDateTime(new Date(conflict.resolvedAt))}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title="ثبت بررسی تعارض"
        confirmLabel="ثبت کن"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setReason('');
        }}
        body={
          <>
            <p style={{ margin: '0 0 12px' }}>
              این مورد به‌عنوان «بررسی‌شده» علامت می‌خورد. هیچ حسابی تغییر نمی‌کند.
            </p>
            <Textarea
              label="نتیجه بررسی"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              hint="این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
            />
            {reason.trim().length > 0 && reason.trim().length < 4 ? (
              <p style={{ fontSize: 12, color: 'var(--bc-color-error)', margin: 0 }}>
                توضیح باید حداقل ۴ نویسه باشد.
              </p>
            ) : null}
          </>
        }
      />
    </>
  );
}
