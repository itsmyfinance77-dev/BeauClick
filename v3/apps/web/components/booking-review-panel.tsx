'use client';

/**
 * DEMO BRANCH ONLY — the customer's review of a completed booking.
 *
 * Shows the review when one exists (the caller's own list is the answer, so a
 * second attempt never gets as far as a 409); otherwise a 1–5 rating and an
 * optional comment. Eligibility is the server's: a refusal is shown in its
 * own words.
 */
import { useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';

import type { ApiClient } from '@/lib/api-client';
import { reviewApi, type MyReview } from '@/lib/review-api';
import { Button } from './ui';
import styles from './checkout-terms.module.css';

const RATINGS = [1, 2, 3, 4, 5] as const;

export function BookingReviewPanel({
  api,
  bookingId,
  existing,
  onSaved,
}: {
  api: ApiClient;
  bookingId: string;
  existing: MyReview | null;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existing) {
    return (
      <div className={styles.panel} data-testid="review-existing">
        <h3 className={styles.heading}>نظر شما</h3>
        <p className={styles.note}>
          امتیاز: <strong>{toPersianDigits(String(existing.rating))} از ۵</strong>
          {existing.status === 'hidden' ? ' — این نظر توسط ناظر پنهان شده است.' : ''}
        </p>
        {existing.comment ? <p className={styles.note}>{existing.comment}</p> : null}
        {existing.response ? (
          <p className={styles.note} data-testid="review-response">
            پاسخ متخصص: {existing.response.text}
          </p>
        ) : null}
      </div>
    );
  }

  async function submit() {
    if (rating === null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = comment.trim();
      await reviewApi.create(api, bookingId, { rating, ...(trimmed ? { comment: trimmed } : {}) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ثبت نظر ممکن نشد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel} data-testid="review-form">
      <h3 className={styles.heading}>ثبت نظر دربارهٔ این نوبت</h3>
      <fieldset className={styles.amounts}>
        <legend className={styles.note}>امتیاز شما</legend>
        {RATINGS.map((r) => (
          <label key={r} className={styles.accept}>
            <input type="radio" name={`rating-${bookingId}`} value={r} checked={rating === r} onChange={() => setRating(r)} />
            <span>{toPersianDigits(String(r))}</span>
          </label>
        ))}
      </fieldset>
      <label className={styles.note} htmlFor={`review-comment-${bookingId}`}>
        توضیح (اختیاری)
      </label>
      <textarea
        id={`review-comment-${bookingId}`}
        value={comment}
        maxLength={2000}
        rows={3}
        onChange={(e) => setComment(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      {error ? (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}
      <Button inline variant="primary" disabled={busy || rating === null} onClick={() => void submit()} data-testid="review-submit">
        {busy ? 'در حال ثبت…' : 'ثبت نظر'}
      </Button>
    </div>
  );
}
