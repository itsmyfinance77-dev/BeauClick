'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, Select } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { auditActions, auditLog, type AuditEntry } from '@/lib/admin-api';
import { SNAPSHOT_LABELS, actionLabel, targetLabel } from '@/lib/audit-labels';
import styles from './audit-log.module.css';

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
    <div className={styles.page}>
      <PageHeader
        title="گزارش عملیات"
        subtitle="هر عملیات مدیریتی به‌صورت دائمی ثبت می‌شود. این گزارش قابل ویرایش یا حذف نیست."
      />

      <section className={styles.panel} aria-label="فیلتر">
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
              {actionLabel(a)}
              {/* The picker lists real actions, and two unlabelled ones would
                  both read «عملیات مدیریتی»: the code tells them apart. */}
              {actionLabel(a) === actionLabel('') ? ` (${a})` : ''}
            </option>
          ))}
        </Select>
      </section>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری گزارش…" lines={4} />
      ) : loaded && entries.length === 0 ? (
        <EmptyState message="عملیاتی با این فیلتر ثبت نشده است." />
      ) : (
        <ul className={styles.entries}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.panel}>
              <div className={styles.head}>
                <div className={styles.what}>
                  <p className={styles.action}>{actionLabel(entry.action)}</p>
                  <p className={styles.when}>{formatZonedDateTime(new Date(entry.createdAt))}</p>
                  <p className={styles.code}>
                    <span className={styles.id}>{entry.action}</span>
                  </p>
                  <p className={styles.who}>
                    عامل: <span className={styles.id}>{entry.actorLabel ?? entry.actorUserId?.slice(0, 8) ?? '—'}</span>
                    {' · '}
                    {targetLabel(entry.targetType)}: <span className={styles.id}>{entry.targetId?.slice(0, 8) ?? '—'}</span>
                  </p>
                </div>
                {/* `bootstrap` is the one-time privileged grant with no
                    session behind it. Marking it visibly means an operator
                    can tell at a glance which rows predate any accountable
                    actor. */}
                {entry.actorLabel ? <Badge tone="warning">{entry.actorLabel}</Badge> : null}
              </div>

              {entry.reason ? <p className={styles.reason}>«{entry.reason}»</p> : null}

              {entry.before || entry.after ? (
                <div className={styles.snapshots}>
                  {entry.before ? <p className={styles.before}>پیش از تغییر: {renderSnapshot(entry.before)}</p> : null}
                  {entry.after ? <p className={styles.after}>پس از تغییر: {renderSnapshot(entry.after)}</p> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {loaded && total > 25 ? (
        <div className={styles.pager}>
          <Button type="button" variant="ghost" inline disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            صفحه قبل
          </Button>
          <span className={styles.pageInfo}>
            صفحه {toPersianDigits(page)} از {toPersianDigits(pageCount)} — مجموع {toPersianDigits(total)} مورد
          </span>
          <Button type="button" variant="ghost" inline disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            صفحه بعد
          </Button>
        </div>
      ) : null}
    </div>
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
