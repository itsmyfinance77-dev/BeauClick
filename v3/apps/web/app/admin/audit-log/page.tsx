'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, Select } from '@/components/pro-ui';
import { useAuth } from '@/lib/auth-context';
import { auditActions, auditLog, type AuditEntry } from '@/lib/admin-api';

/**
 * The permanent record of every privileged action.
 *
 * There is no edit control and no delete control on this screen, and that is
 * not the guarantee -- `admin.admin_audit_log` is owned by a role the
 * application never connects as, and the application holds INSERT + SELECT
 * only, so a mutation route added here in future would be refused by PostgreSQL
 * rather than by this file's restraint.
 */
export default function AdminAuditLogPage() {
  const { api } = useAuth();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await auditLog(api, { page, limit: 25, action: action || undefined });
      setEntries(res.data ?? []);
      setTotal(res.meta?.pagination?.total ?? 0);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'گزارش عملیات بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, page, action]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // A picker of REAL action names, so the filter is not a guess-the-string
    // box. Its failure is tolerated independently: an empty picker is a worse
    // filter, not a broken page.
    auditActions(api)
      .then((res) => setActions(res.data ?? []))
      .catch(() => setActions([]));
  }, [api]);

  const pageCount = Math.max(1, Math.ceil(total / 25));

  return (
    <>
      <PageHeader
        title="گزارش عملیات"
        subtitle="هر عملیات مدیریتی به‌صورت دائمی ثبت می‌شود. این گزارش قابل ویرایش یا حذف نیست."
      />

      <Card>
        <Select
          label="فیلتر بر اساس نوع عملیات"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          <option value="">همه عملیات</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a] ?? a}
            </option>
          ))}
        </Select>
      </Card>

      <div style={{ marginBlockStart: 20 }}>
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری گزارش…" />
        ) : loaded && entries.length === 0 ? (
          <EmptyState message="عملیاتی با این فیلتر ثبت نشده است." />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {entries.map((entry) => (
              <Card key={entry.id}>
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
                    <p style={{ margin: 0, fontWeight: 700 }}>{ACTION_LABELS[entry.action] ?? entry.action}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                      {formatZonedDateTime(new Date(entry.createdAt))}
                    </p>
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                      عامل:{' '}
                      <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                        {entry.actorLabel ?? entry.actorUserId?.slice(0, 8) ?? '—'}
                      </span>
                      {' · '}
                      {TARGET_LABELS[entry.targetType] ?? entry.targetType}:{' '}
                      <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                        {entry.targetId?.slice(0, 8) ?? '—'}
                      </span>
                    </p>
                  </div>
                  {/* `bootstrap` is the one-time privileged grant with no
                      session behind it. Marking it visibly means an operator
                      can tell at a glance which rows predate any accountable
                      actor. */}
                  {entry.actorLabel ? <Badge tone="warning">{entry.actorLabel}</Badge> : null}
                </div>

                {entry.reason ? (
                  <p style={{ margin: '12px 0 0', fontSize: 14 }}>«{entry.reason}»</p>
                ) : null}

                {entry.before || entry.after ? (
                  <div
                    style={{
                      marginBlockStart: 12,
                      paddingBlockStart: 12,
                      borderBlockStart: '1px solid var(--bc-color-line)',
                      fontSize: 13,
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    {entry.before ? (
                      <p style={{ margin: 0, color: 'var(--bc-color-ink-soft)' }}>
                        پیش از تغییر: {renderSnapshot(entry.before)}
                      </p>
                    ) : null}
                    {entry.after ? (
                      <p style={{ margin: 0 }}>پس از تغییر: {renderSnapshot(entry.after)}</p>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}

        {loaded && total > 25 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--bc-spacing-chip-gap)',
              marginBlockStart: 16,
            }}
          >
            <Button type="button" variant="ghost" inline disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              صفحه قبل
            </Button>
            <span style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
              صفحه {toPersianDigits(page)} از {toPersianDigits(pageCount)} — مجموع {toPersianDigits(total)} مورد
            </span>
            <Button
              type="button"
              variant="ghost"
              inline
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              صفحه بعد
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * A bounded snapshot rendered as text.
 *
 * `AuditSnapshot` cannot express a nested object by construction, so there is
 * no blob to pretty-print and nothing secret-bearing to redact on the way out --
 * the constraint is enforced where the record is written.
 */
function renderSnapshot(snapshot: Record<string, string | number | boolean | null>): string {
  return Object.entries(snapshot)
    .map(([key, value]) => `${SNAPSHOT_LABELS[key] ?? key}: ${value === null ? '—' : toPersianDigits(String(value))}`)
    .join('، ');
}

const ACTION_LABELS: Record<string, string> = {
  'identity.role_granted': 'اعطای نقش',
  'identity.role_revoked': 'لغو نقش',
  'identity.phone_conflict_resolved': 'رفع تعارض شماره',
  'provider.verification_approved': 'تأیید احراز هویت',
  'provider.verification_rejected': 'رد احراز هویت',
  'financial.settlement_created': 'ثبت تسویه',
  'financial.settlement_reversed': 'برگشت تسویه',
  'search.reindex_triggered': 'بازسازی نمایه جست‌وجو',
  'search.projection_rebuilt': 'بازسازی کامل پروجکشن جست‌وجو',
  'notification.retry_due_triggered': 'تلاش مجدد ارسال اعلان‌ها',
};

const TARGET_LABELS: Record<string, string> = {
  user: 'کاربر',
  professional: 'متخصص',
  phone_conflict: 'تعارض شماره',
  settlement_batch: 'دسته تسویه',
  search_index: 'نمایه',
  notification_sweep: 'اعلان‌ها',
};

const SNAPSHOT_LABELS: Record<string, string> = {
  roles: 'نقش‌ها',
  role: 'نقش',
  verificationStatus: 'وضعیت احراز',
  requestId: 'شناسه درخواست',
  resolvedAt: 'زمان رفع',
  amountToman: 'مبلغ',
  orderCount: 'تعداد سفارش',
  partyType: 'نوع طرف',
  partyId: 'شناسه طرف',
  method: 'روش',
  reversalId: 'شناسه برگشت',
  indexed: 'تعداد نمایه‌شده',
  projectionRows: 'ردیف پروجکشن',
  attempted: 'تلاش',
  sent: 'ارسال‌شده',
  deadLettered: 'ناموفق نهایی',
};
