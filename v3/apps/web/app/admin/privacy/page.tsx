'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, DataCell, DataRow, DataTable, EmptyState, PageHeader, Select } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { privacyRequests, type AdminPrivacyRequest } from '@/lib/admin-api';
import { PRIVACY_KIND_LABEL, PRIVACY_STATUS_LABEL, privacyKindLabel, privacyStatusView } from '@/lib/moderation-labels';
import styles from './privacy.module.css';

const PAGE_SIZE = 20;

/**
 * `/admin/privacy` — `31_ADMIN_PRIVACY_QUEUE.md`. A monitor, not a control.
 *
 * One read route, a status filter and pagination; nothing else. There is no
 * download, no cancel, no row that opens anything — not hidden or disabled,
 * absent, because the API has none of them and adding one (an operator
 * cancelling somebody's erasure, reading somebody's export) would be a
 * deliberate security breach of Phase E's design rather than a gap.
 *
 * The design's filter by kind is here now that the route accepts one (#266).
 * Both filters are sent to the server and neither is applied in the browser:
 * the count under the table comes from `meta.pagination.total`, so narrowing
 * one page locally would leave it describing a set the operator cannot see.
 */
export default function AdminPrivacyPage() {
  // Operational/security surface, not content moderation.
  return (
    <AdminGuard capability="bc_manage_platform">
      <PrivacyMonitor />
    </AdminGuard>
  );
}

const date = (value: string | null) => (value ? formatZonedDateTime(new Date(value)) : null);

/** Erasure: when the grace window closes. Export: when the file stops being downloadable. */
function deadline(request: AdminPrivacyRequest): string {
  if (request.kind === 'erasure' && request.executeAfter) return `اجرا پس از ${date(request.executeAfter)}`;
  if (request.kind === 'export' && request.expiresAt) return `انقضا ${date(request.expiresAt)}`;
  return '—';
}

function PrivacyMonitor() {
  const { api } = useAuth();
  const [items, setItems] = useState<AdminPrivacyRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState<'' | 'export' | 'erasure'>('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await privacyRequests(api, { page, limit: PAGE_SIZE, status: status || undefined, kind: kind || undefined });
      setItems(res.data ?? []);
      setTotal(res.meta?.pagination?.total ?? (res.data ?? []).length);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست درخواست‌های حریم خصوصی بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, page, status, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={styles.page}>
      <PageHeader title="درخواست‌های حریم خصوصی" subtitle="وضعیتِ درخواست‌های دریافت داده و حذف حساب کاربران." />

      <p role="note" className={styles.banner}>
        این صفحه فقط وضعیت را نشان می‌دهد. دانلودِ داده یا لغوِ حذف از اینجا ممکن نیست.
      </p>

      <div className={styles.filters}>
        <Select
          label="وضعیت"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">همه</option>
          {Object.entries(PRIVACY_STATUS_LABEL).map(([value, view]) => (
            <option key={value} value={value}>
              {view.label}
            </option>
          ))}
        </Select>

        <Select
          label="نوع"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as '' | 'export' | 'erasure');
            setPage(1);
          }}
        >
          <option value="">همه</option>
          {Object.entries(PRIVACY_KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <section aria-labelledby={titleId} className={styles.list} aria-busy={loading || undefined}>
        <h2 id={titleId} className={styles.sectionTitle}>
          درخواست‌ها
        </h2>
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری…" lines={4} />
        ) : loaded && items.length === 0 ? (
          <EmptyState message="صفی برای نشان‌دادن نیست." />
        ) : loaded ? (
          <DataTable
            head={['شناسهٔ کاربر', 'نوع', 'وضعیت', 'تاریخ درخواست', 'مهلت / انقضا', 'کد خطا']}
            aria-labelledby={titleId}
          >
            {items.map((request) => {
              const view = privacyStatusView(request.status);
              return (
                <DataRow key={request.id} data-request={request.id}>
                  <DataCell label="شناسهٔ کاربر">
                    <span className={styles.id}>{request.subjectUserId.slice(0, 8)}</span>
                  </DataCell>
                  <DataCell label="نوع">{privacyKindLabel(request.kind)}</DataCell>
                  <DataCell label="وضعیت">
                    <Badge tone={view.tone}>{view.label}</Badge>
                  </DataCell>
                  <DataCell label="تاریخ درخواست">{date(request.requestedAt)}</DataCell>
                  <DataCell label="مهلت / انقضا">{deadline(request)}</DataCell>
                  <DataCell label="کد خطا">
                    {request.status === 'failed' && request.failureCode ? (
                      <span className={styles.id}>{request.failureCode}</span>
                    ) : (
                      '—'
                    )}
                  </DataCell>
                </DataRow>
              );
            })}
          </DataTable>
        ) : null}
      </section>

      {loaded && total > 0 ? (
        <nav className={styles.pager} aria-label="صفحه‌بندی">
          <Button type="button" variant="ghost" inline disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
            صفحهٔ قبل
          </Button>
          <span className={styles.pageOf} aria-live="polite">
            صفحهٔ {toPersianDigits(page)} از {toPersianDigits(pages)} · {toPersianDigits(total)} درخواست
          </span>
          <Button type="button" variant="ghost" inline disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
            صفحهٔ بعد
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
