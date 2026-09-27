'use client';

/**
 * DEMO BRANCH ONLY — the professional's reviews and their replies.
 *
 * Reads the professional's own public list (`GET /v1/providers/:id/reviews`,
 * the same list customers see, replies included) and replies through
 * `POST /v1/providers/:id/reviews/:reviewId/respond`. A reply can be edited:
 * the server keeps the professional's latest words (the review itself cannot
 * change). Ownership is the server's; a refusal is shown in its own words.
 */
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { EmptyState, PageHeader, Textarea } from '@/components/kit';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import type { MyProviderProfile } from '@/lib/pro-api';
import { reviewApi, type PublicReview } from '@/lib/review-api';
import styles from './reviews.module.css';

const REPLY_MAX = 2000;

export default function ProReviewsPage() {
  return <ProGuard>{(profile) => <ProReviews profile={profile} />}</ProGuard>;
}

function ProReviews({ profile }: { profile: MyProviderProfile }) {
  const { api } = useAuth();
  const [reviews, setReviews] = useState<PublicReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await reviewApi.forProfessional(api, profile.id);
      setReviews(res.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'نظرات بارگذاری نشد.');
    }
  }, [api, profile.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(review: PublicReview) {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setActionError(null);
    try {
      await reviewApi.respond(api, profile.id, review.id, text);
      setEditing(null);
      // The server's list is the answer, not the draft.
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ثبت پاسخ ممکن نشد.');
    } finally {
      setBusy(false);
    }
  }

  if (error && reviews === null) return <ErrorState message={error} onRetry={() => void load()} />;
  if (reviews === null) return <LoadingState label="در حال بارگذاری نظرات…" lines={4} />;

  return (
    <section>
      <PageHeader title="نظرات مشتریان" />
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}
      {reviews.length === 0 ? (
        <EmptyState message="هنوز نظری برای شما ثبت نشده است. مشتری پس از انجام نوبت می‌تواند نظر بدهد." />
      ) : (
        <ul className={styles.list} data-testid="pro-reviews">
          {reviews.map((review) => (
            <li key={review.id} className={styles.card} data-review={review.id}>
              <p className={styles.meta}>
                {formatFullJalaliDate(new Date(review.createdAt))} — امتیاز {toPersianDigits(String(review.rating))} از ۵
              </p>
              {review.comment ? <p className={styles.comment}>{review.comment}</p> : <p className={styles.meta}>بدون توضیح</p>}
              {review.response && editing !== review.id ? (
                <p className={styles.reply} data-testid="pro-review-reply">
                  پاسخ شما: {review.response.text}
                </p>
              ) : null}
              {editing === review.id ? (
                <div className={styles.form}>
                  <Textarea
                    label="پاسخ شما"
                    value={draft}
                    maxLength={REPLY_MAX}
                    rows={3}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className={styles.actions}>
                    <Button inline disabled={busy || !draft.trim()} loading={busy} onClick={() => void save(review)} data-testid="pro-review-save">
                      ثبت پاسخ
                    </Button>
                    <Button inline variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                      انصراف
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={styles.actions}>
                  <Button
                    inline
                    variant="ghost"
                    onClick={() => {
                      setEditing(review.id);
                      setDraft(review.response?.text ?? '');
                      setActionError(null);
                    }}
                  >
                    {review.response ? 'ویرایش پاسخ' : 'پاسخ دادن'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
