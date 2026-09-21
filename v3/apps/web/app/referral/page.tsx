'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import {
  REFERRAL_CLAIM_ATTEMPTS_PER_HOUR,
  REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS,
  REFERRAL_SHARE_TITLE,
  isReferralCodeShape,
  type ReferralClaimResult,
  type ReferralCodeView,
} from '@beauclick/referral-contract';
import { ProtectedRoute } from '@/components/protected-route';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { claimReferral, classifyClaimFailure, referralCode, type ClaimFailure } from '@/lib/referral-api';
import styles from './referral.module.css';

/**
 * Referral — `39_REFERRAL.md`.
 *
 * Only two routes exist, and neither reads a referral's status. So this page is
 * exactly two things: the customer's own code to share, and a box to claim a
 * friend's. It says nothing about anyone else's referral, counts nothing, and
 * shows no reward figure — `REFERRAL_REWARD_DEFAULTS` are both zero and the
 * page says so plainly rather than promising anything.
 *
 * The persistent states a designer might expect — pending, qualified, expired,
 * reversed, capped — are NOT built: there is no route to read them
 * (`REFERRAL-STATUS-READ`), and inventing them would be a screen of made-up
 * numbers. Qualified and reversed reach the customer once, honestly, as a
 * notification that links here.
 */
export default function ReferralPage() {
  return (
    <ProtectedRoute>
      <Referral />
    </ProtectedRoute>
  );
}

function Referral() {
  const { api } = useAuth();
  const [view, setView] = useState<ReferralCodeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await referralCode(api);
      setView(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'کد دعوت شما بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.page}>
      <PageHeader title="دعوت دوستان" subtitle="کد دعوت خود را برای دوستانتان بفرستید، یا کد دوستی را وارد کنید." />

      <div className={styles.columns}>
        {loading ? (
          <LoadingState label="در حال بارگذاری کد دعوت…" lines={4} />
        ) : error || !view ? (
          <ErrorState message={error ?? 'کد دعوت شما بارگذاری نشد.'} onRetry={() => void load()} />
        ) : (
          <SharePanel view={view} />
        )}

        {/* The claim box is offered unconditionally. `V32-DEC-019` makes the
            claim route the ONLY oracle for eligibility; hiding the box for an
            "ineligible" customer would need exactly the read route that does not
            exist, and would leak what the server refuses to reveal. It also does
            not wait for the code to load — the two are independent. */}
        <ClaimPanel />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- sharing

function SharePanel({ view }: { view: ReferralCodeView }) {
  const [announcement, setAnnouncement] = useState('');
  // `navigator.share` is present on some mobile browsers and absent on most
  // desktop ones, and is refused outside a user gesture. It is checked after
  // mount and only ever ADDS a control: copying the code and the link is always
  // there and never depends on it.
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(view.shareChannels.includes('native_share') && typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, [view.shareChannels]);

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(done);
    } catch {
      setAnnouncement('کپی انجام نشد. متن را انتخاب کنید و دستی کپی کنید.');
    }
  }

  async function share() {
    try {
      await navigator.share({ title: REFERRAL_SHARE_TITLE, text: view.shareText, url: view.inviteUrl });
      setAnnouncement('');
    } catch (err) {
      // Closing the share sheet is the customer's choice, not a failure: no
      // message, no "sent" claim, and the copy controls are untouched.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setAnnouncement('');
        return;
      }
      setAnnouncement('اشتراک‌گذاری انجام نشد. از کپی استفاده کنید.');
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="referral-share-heading">
      <h2 id="referral-share-heading" className={styles.title}>
        کد دعوت شما
      </h2>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>کد</span>
        <p className={`${styles.value} ${styles.code}`} data-testid="referral-code">
          {view.code}
        </p>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>پیوند دعوت</span>
        <p className={`${styles.value} ${styles.link}`} data-testid="referral-link">
          {view.inviteUrl}
        </p>
      </div>

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={() => void copy(view.code, 'کد کپی شد.')}>
          کپیِ کد
        </Button>
        <Button type="button" variant="ghost" onClick={() => void copy(view.inviteUrl, 'پیوند کپی شد.')}>
          کپیِ پیوند
        </Button>
        {canShare ? (
          <Button type="button" onClick={() => void share()}>
            اشتراک‌گذاری
          </Button>
        ) : null}
      </div>

      <p className={styles.announce} role="status" aria-live="polite">
        {announcement}
      </p>

      {/* Both reward values are configured to zero (`V32-DEC-016`). It is a fixed
          fact of the programme and not a per-customer status, so it is stated
          here permanently instead of being hidden or replaced with an example.
          Engineering-authored wording pending approved referral copy
          (dependency-ledger blocker 16). */}
      <p className={styles.disclosure}>
        در حال حاضر دعوت دوستان امتیاز یا پاداشی ندارد. دعوت هنگامی تکمیل می‌شود که دوستِ دعوت‌شده نخستین رزروِ انجام‌شدهٔ خود را
        داشته باشد.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ claiming

type ClaimState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: ReferralClaimResult }
  | { kind: 'failure'; failure: ClaimFailure; message: string };

const FAILURE_TITLE: Record<ClaimFailure, string> = {
  refused: 'این کد قابل استفاده نیست',
  throttled: 'تعداد تلاش‌ها بیش از حد مجاز است',
  invalid: 'درخواست نامعتبر است',
  failed: 'ثبت کد انجام نشد',
};

/** The server's Persian sentence when it sent one; these only cover an empty message. */
const FAILURE_FALLBACK: Record<ClaimFailure, string> = {
  refused: 'این کد دعوت برای حساب شما قابل استفاده نیست.',
  throttled: 'تعداد تلاش‌های شما برای ثبت کد دعوت بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
  invalid: 'درخواست نامعتبر است.',
  failed: 'ثبت کد دعوت انجام نشد. دوباره تلاش کنید.',
};

function ClaimPanel() {
  const { api } = useAuth();
  const [code, setCode] = useState('');
  const [state, setState] = useState<ClaimState>({ kind: 'idle' });

  const trimmed = code.trim();
  const shapeOk = isReferralCodeShape(trimmed);
  const throttled = state.kind === 'failure' && state.failure === 'throttled';
  const submitting = state.kind === 'submitting';
  const canSubmit = shapeOk && !submitting && !throttled;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setState({ kind: 'submitting' });
    try {
      const res = await claimReferral(api, trimmed);
      if (res.data) {
        setState({ kind: 'success', result: res.data });
        setCode('');
      } else {
        setState({ kind: 'failure', failure: 'failed', message: FAILURE_FALLBACK.failed });
      }
    } catch (err) {
      const failure = classifyClaimFailure(err);
      const message = err instanceof Error && err.message ? err.message : FAILURE_FALLBACK[failure];
      setState({ kind: 'failure', failure, message });
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="referral-claim-heading" aria-busy={submitting || undefined}>
      <h2 id="referral-claim-heading" className={styles.title}>
        استفاده از دعوت یک دوست
      </h2>

      {state.kind === 'success' ? <ClaimSuccess result={state.result} /> : null}

      {state.kind === 'failure' ? (
        <div role="alert" className={`${styles.result} ${state.failure === 'throttled' ? styles.notice : styles.problem}`}>
          <p className={styles.resultTitle}>{FAILURE_TITLE[state.failure]}</p>
          <p className={styles.resultText}>{state.message}</p>
          {state.failure === 'throttled' ? (
            // The published limit, and no countdown: the server returns none, and a
            // client-invented one would count down to a moment that can still fail.
            <p className={styles.resultText}>
              حداکثر {toPersianDigits(REFERRAL_CLAIM_ATTEMPTS_PER_HOUR)} تلاش در هر ساعت مجاز است.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.kind !== 'success' ? (
        <form onSubmit={submit} noValidate>
          <p className={styles.lead}>اگر دوستی کد دعوت خود را برای شما فرستاده است، اینجا وارد کنید.</p>
          <div className={styles.claimField}>
            <label htmlFor="referral-claim-code-input" className={styles.claimLabel}>
              کد دعوت دوست
            </label>
            <input
              id="referral-claim-code-input"
              className={styles.claimInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-describedby="referral-claim-code-hint"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              dir="ltr"
            />
            <span id="referral-claim-code-hint" className={styles.claimHint}>
              کد ده نویسه است و با حروف بزرگ انگلیسی و رقم نوشته می‌شود. هر تلاش، حتی ناموفق، از سهم ساعتی شما کم می‌کند.
            </span>
          </div>
          <Button type="submit" disabled={!canSubmit} loading={submitting}>
            ثبت کد
          </Button>
        </form>
      ) : null}
    </section>
  );
}

/**
 * The one moment a customer's own attribution facts are visible: there is no
 * route to read them again. Shown from the response itself (`attributedAt`,
 * `expiresAt`), with the "90 days" only as a secondary explanation, never in
 * place of the exact date. Says «رزروِ انجام‌شده», never «رزرو» or «پرداخت» —
 * only a completed booking qualifies a referral.
 */
function ClaimSuccess({ result }: { result: ReferralClaimResult }) {
  return (
    <div role="status" className={`${styles.result} ${styles.success}`}>
      <p className={styles.resultTitle}>کد دعوت ثبت شد</p>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>زمان ثبت</dt>
          <dd>{formatZonedDateTime(new Date(result.attributedAt))}</dd>
        </div>
        <div className={styles.fact}>
          <dt>مهلت تکمیل نخستین رزرو</dt>
          <dd>{formatZonedFullDate(new Date(result.expiresAt))}</dd>
        </div>
      </dl>
      <p className={styles.resultText}>
        این مهلت {toPersianDigits(REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS)} روز پس از ثبت است. این اطلاعات فقط همین یک بار نمایش داده
        می‌شود.
      </p>
    </div>
  );
}
