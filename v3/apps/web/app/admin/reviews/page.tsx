'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, DataCell, DataRow, DataTable, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { moderateReview, reviewQueue, type ReviewQueueItem } from '@/lib/admin-api';
import { reviewStatusView } from '@/lib/moderation-labels';
import styles from './reviews.module.css';

/** `ModerateReviewDto`: 4–500 characters, in both directions. */
const MIN_REASON = 4;

/**
 * `/admin/reviews` — `28_ADMIN_REVIEW_MODERATION.md`.
 *
 * Reviews are public from the moment they are written, so this queue is
 * after-the-fact moderation, not a gate. Both decisions are reversible —
 * «انتشار» on a hidden review restores it and its rating — which is why there
 * is no irreversible-deletion confirmation here, unlike `/admin/media`.
 *
 * Deliberately untouched: whether loyalty points earned for a review are taken
 * back when the review is hidden. Spec 28 records that as an open product
 * question (today the customer keeps them); this page does not decide it and
 * calls nothing in loyalty.
 */
export default function AdminReviewsPage() {
  // Content moderation: `moderator` and `administrator` hold it, the
  // operational `platform_operator` does not.
  return (
    <AdminGuard capability="bc_moderate_reviews">
      <ReviewQueue />
    </AdminGuard>
  );
}

function refusalMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'CONFLICT') return 'این دیدگاه پیش‌تر بازبینی شده است. صف تازه شد.';
    if (err.status === 404) return 'این دیدگاه دیگر در صف نیست. صف تازه شد.';
    return err.message;
  }
  return 'ثبت تصمیم انجام نشد.';
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className={styles.stars} aria-label={`${toPersianDigits(rating)} ستاره از ${toPersianDigits(5)}`}>
      <span aria-hidden="true">★ {toPersianDigits(rating)}</span>
    </span>
  );
}

function ReviewQueue() {
  const { api } = useAuth();
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'hide' | 'publish' | null>(null);

  const titleId = useId();
  const panelId = useId();
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const queueRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusIndexAfterLoad = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await reviewQueue(api);
      setItems(res.data ?? []);
      setTotal(res.meta?.pagination?.total ?? (res.data ?? []).length);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'صف بازبینی دیدگاه‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // `Button` does not forward a ref; the row's `data-review` names its button.
  const rowButton = (id: string) =>
    queueRef.current?.querySelector<HTMLButtonElement>(`[data-review="${id}"] button`) ?? null;

  useEffect(() => {
    const index = focusIndexAfterLoad.current;
    if (index === null || loading) return;
    focusIndexAfterLoad.current = null;
    const next = items[Math.min(index, items.length - 1)];
    if (next) rowButton(next.id)?.focus();
    else headingRef.current?.focus();
  }, [items, loading]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId) panelHeadingRef.current?.focus();
  }, [selectedId]);

  function close() {
    const id = selectedId;
    setSelectedId(null);
    setReason('');
    if (id) rowButton(id)?.focus();
  }

  async function decide(decision: 'hide' | 'publish') {
    if (!selected) return;
    const index = items.findIndex((item) => item.id === selected.id);
    setBusy(decision);
    setError(null);
    try {
      await moderateReview(api, selected.id, { decision, reason: reason.trim() });
      setSelectedId(null);
      setReason('');
      focusIndexAfterLoad.current = index;
      await load();
    } catch (err) {
      setSelectedId(null);
      setReason('');
      // Reload FIRST, then report: `load` clears the error.
      const message = refusalMessage(err);
      focusIndexAfterLoad.current = index;
      await load();
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  const reasonLength = reason.trim().length;
  const reasonTooShort = reasonLength < MIN_REASON;

  return (
    <div className={styles.page}>
      <PageHeader
        title="بازبینی دیدگاه‌ها"
        subtitle="دیدگاه‌ها از لحظهٔ ثبت عمومی‌اند؛ این صف برای بازبینیِ پس از انتشار است. هر تصمیم با نام شما و دلیل آن ثبت می‌شود."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <div className={`${styles.layout} ${selected ? styles.withPanel : ''}`}>
        <section ref={queueRef} className={styles.queue} aria-labelledby={titleId}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.sectionTitle}>
            دیدگاه‌های بازبینی‌نشده
          </h2>
          {loading && !loaded ? (
            <LoadingState label="در حال بارگذاری صف…" lines={4} />
          ) : loaded && items.length === 0 ? (
            <EmptyState message="صف بازبینی خالی است." />
          ) : loaded ? (
            <>
              <DataTable head={['کنش', 'متخصص', 'امتیاز', 'متن دیدگاه', 'تاریخ']} aria-labelledby={titleId}>
                {items.map((item) => {
                  const date = formatZonedDateTime(new Date(item.createdAt));
                  return (
                    <DataRow key={item.id} data-review={item.id} data-selected={item.id === selectedId || undefined}>
                      <DataCell label="کنش">
                        <Button
                          type="button"
                          variant="ghost"
                          inline
                          aria-expanded={item.id === selectedId}
                          aria-controls={panelId}
                          aria-label={`بررسی دیدگاه دربارهٔ «${item.displayName}» از ${date}`}
                          onClick={() => {
                            setSelectedId(item.id);
                            setReason('');
                          }}
                        >
                          بررسی
                        </Button>
                      </DataCell>
                      <DataCell label="متخصص">{item.displayName}</DataCell>
                      <DataCell label="امتیاز">
                        <Badge tone="primary">
                          <Stars rating={item.rating} />
                        </Badge>
                      </DataCell>
                      <DataCell label="متن دیدگاه">
                        {item.comment ? (
                          <span className={styles.clamp}>{item.comment}</span>
                        ) : (
                          <span className={styles.muted}>بدون متن</span>
                        )}
                      </DataCell>
                      <DataCell label="تاریخ">{date}</DataCell>
                    </DataRow>
                  );
                })}
              </DataTable>
              <p className={styles.count}>
                {toPersianDigits(total)} دیدگاه در صف
                {total > items.length ? ` — ${toPersianDigits(items.length)} مورد قدیمی‌تر در این صفحه` : ''}.
              </p>
            </>
          ) : null}
        </section>

        {selected ? (
          <section id={panelId} className={styles.panel} aria-labelledby={`${panelId}-title`} data-panel={selected.id}>
            <div className={styles.panelHead}>
              <h2 id={`${panelId}-title`} ref={panelHeadingRef} tabIndex={-1} className={styles.panelTitle}>
                دیدگاه دربارهٔ {selected.displayName}
              </h2>
              <Button type="button" variant="ghost" inline onClick={close} disabled={busy !== null}>
                بستن
              </Button>
            </div>

            <dl className={styles.meta}>
              <div>
                <dt>امتیاز</dt>
                <dd>
                  <Stars rating={selected.rating} />
                </dd>
              </div>
              <div>
                <dt>وضعیت کنونی</dt>
                <dd>
                  <Badge tone={reviewStatusView(selected.status).tone}>{reviewStatusView(selected.status).label}</Badge>
                </dd>
              </div>
              <div>
                <dt>تاریخ ثبت</dt>
                <dd>{formatZonedDateTime(new Date(selected.createdAt))}</dd>
              </div>
              <div>
                <dt>متن کامل</dt>
                <dd>{selected.comment ? <span className={styles.comment}>{selected.comment}</span> : 'بدون متن'}</dd>
              </div>
            </dl>

            <Textarea
              label="دلیل تصمیم"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              hint="اجباری در هر دو تصمیم، حداقل ۴ نویسه. این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
            />
            {reasonLength > 0 && reasonTooShort ? (
              <p className={styles.reasonError}>دلیل باید حداقل ۴ نویسه باشد.</p>
            ) : null}

            {/*
              Two decisions of EQUAL weight (spec 28): same variant, same size,
              neither focused first nor visually primary. Keeping a fair review
              up is as much a decision as taking an unfair one down.
            */}
            <div className={styles.decisions} role="group" aria-label="تصمیم">
              <Button
                type="button"
                variant="ghost"
                inline
                loading={busy === 'publish'}
                disabled={reasonTooShort || busy !== null}
                onClick={() => void decide('publish')}
              >
                انتشار
              </Button>
              <Button
                type="button"
                variant="ghost"
                inline
                loading={busy === 'hide'}
                disabled={reasonTooShort || busy !== null}
                onClick={() => void decide('hide')}
              >
                حذف
              </Button>
            </div>
            <p className={styles.hint}>
              «حذف» دیدگاه و امتیازش را از نمایهٔ عمومی و رتبه‌بندی برمی‌دارد؛ «انتشار» آن را همان‌طور که هست نگه
              می‌دارد. هر دو دیدگاه را از این صف خارج می‌کنند.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
