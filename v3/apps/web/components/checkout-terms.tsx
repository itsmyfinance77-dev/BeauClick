'use client';

/**
 * DEMO BRANCH ONLY (DEMO-DEC-001, part A) — never merged to master.
 *
 * The customer's cancellation / no-show terms before payment, and the terms a
 * booking was accepted under afterwards.
 *
 * - The checkbox starts UNCHECKED and is never checked by the page itself.
 * - While the disclosure is loading, or when it failed, the parent cannot enable
 *   payment (`checkoutReady` below is the one predicate it uses).
 * - An unenrolled seller shows no terms at all — nothing is fabricated.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';

import type { ApiClient } from '@/lib/api-client';
import {
  customerRetention,
  loadAcceptedTerms,
  loadDisclosure,
  tehranDateTime,
  type AcceptedTerms,
  type CheckoutDisclosure,
} from '@/lib/checkout-terms';
import type { BookingOutcomeRetentionRule } from '@/lib/pro-api';
import styles from './checkout-terms.module.css';

export type DisclosureState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; disclosure: CheckoutDisclosure };

function isValidDisclosure(d: unknown): d is CheckoutDisclosure {
  if (!d || typeof d !== 'object') return false;
  const x = d as Partial<CheckoutDisclosure>;
  if (typeof x.acceptanceRequired !== 'boolean' || !x.amounts || typeof x.amounts.serviceTotalToman !== 'number') return false;
  if (x.acceptanceRequired) {
    const a = x.acceptance;
    return Boolean(
      x.outcome &&
        x.outcome.copy &&
        a &&
        typeof a.policyKey === 'string' &&
        typeof a.policyVersion === 'number' &&
        typeof a.copyKey === 'string' &&
        typeof a.copyVersion === 'number',
    );
  }
  return x.acceptance === null || x.acceptance === undefined;
}

/** Loads the server's disclosure for exactly this (professional, service, slot). */
export function useCheckoutDisclosure(
  api: ApiClient,
  q: { professionalId: string; serviceId: string | null; slotId: string | null; enabled: boolean },
) {
  const [state, setState] = useState<DisclosureState>({ status: 'idle' });
  const seq = useRef(0);
  const reload = useCallback(async (): Promise<CheckoutDisclosure | null> => {
    if (!q.enabled || !q.serviceId || !q.slotId) {
      setState({ status: 'idle' });
      return null;
    }
    const mine = ++seq.current;
    setState({ status: 'loading' });
    try {
      const res = await loadDisclosure(api, { professionalId: q.professionalId, serviceId: q.serviceId, slotId: q.slotId });
      if (mine !== seq.current) return null; // a later selection superseded this read
      // A disclosure that cannot be read as one is a failed disclosure: payment stays closed.
      if (!isValidDisclosure(res.data)) throw new Error('invalid disclosure');
      setState({ status: 'ready', disclosure: res.data });
      return res.data;
    } catch (err) {
      if (mine !== seq.current) return null;
      setState({ status: 'error', message: err instanceof Error ? err.message : 'شرایط رزرو بارگذاری نشد.' });
      return null;
    }
  }, [api, q.enabled, q.professionalId, q.serviceId, q.slotId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}

/** Payment may start only when the disclosure is loaded and, where required, accepted. */
export function checkoutReady(state: DisclosureState, accepted: boolean): boolean {
  if (state.status !== 'ready') return false;
  return state.disclosure.acceptanceRequired ? accepted : true;
}

interface TermsLike {
  cutoffHours: number;
  cutoffInstant: string;
  lateCancellationRetention: BookingOutcomeRetentionRule;
  noShowGraceMinutes: number;
  noShowRetention: BookingOutcomeRetentionRule;
  rescheduleFreeCountBeforeCutoff: number;
  disputeWindowHours: number;
}

/** Read-only rendering of one set of terms (used before payment and in booking details). */
export function TermsBlock({ terms, copyBody }: { terms: TermsLike; copyBody: string | null }) {
  return (
    <div className={styles.terms}>
      <dl className={styles.list}>
        <dt>لغو رایگان تا</dt>
        <dd>
          {tehranDateTime(terms.cutoffInstant)} ({toPersianDigits(String(terms.cutoffHours))} ساعت پیش از نوبت، به وقت تهران)
        </dd>
        <dt>لغو پس از آن</dt>
        <dd>{customerRetention(terms.lateCancellationRetention)}</dd>
        <dt>عدم حضور</dt>
        <dd>
          پس از {toPersianDigits(String(terms.noShowGraceMinutes))} دقیقه تأخیر ثبت می‌شود؛ {customerRetention(terms.noShowRetention)}
        </dd>
        <dt>جابه‌جایی رایگان</dt>
        <dd>{toPersianDigits(String(terms.rescheduleFreeCountBeforeCutoff))} بار پیش از مهلت لغو</dd>
        <dt>مهلت اعتراض</dt>
        <dd>{toPersianDigits(String(terms.disputeWindowHours))} ساعت</dd>
      </dl>
      {copyBody ? (
        <div className={styles.copy} data-testid="terms-copy">
          {copyBody}
        </div>
      ) : null}
    </div>
  );
}

export function CheckoutTermsPanel({
  state,
  accepted,
  onAcceptedChange,
  changedNotice,
}: {
  state: DisclosureState;
  accepted: boolean;
  onAcceptedChange: (next: boolean) => void;
  changedNotice: boolean;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <div className={styles.panel} role="status" data-testid="terms-loading">
        در حال دریافت شرایط رزرو…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={`${styles.panel} ${styles.error}`} role="alert" data-testid="terms-error">
        شرایط رزرو دریافت نشد، پس پرداخت آغاز نمی‌شود. دوباره زمان را انتخاب کنید یا کمی بعد تلاش کنید.
      </div>
    );
  }
  const d = state.disclosure;
  return (
    <div className={styles.panel} data-testid="checkout-terms">
      <div className={styles.amounts}>
        <span>مبلغ خدمت</span>
        <strong>{formatToman(d.amounts.serviceTotalToman)} تومان</strong>
        <span>پرداخت اکنون</span>
        <strong>{formatToman(d.amounts.platformCollectibleNowToman)} تومان</strong>
        {d.amounts.venueBalanceToman > 0 ? (
          <>
            <span>پرداخت در محل</span>
            <strong>{formatToman(d.amounts.venueBalanceToman)} تومان</strong>
          </>
        ) : null}
      </div>
      {d.acceptanceRequired && d.outcome ? (
        <>
          <h3 className={styles.heading}>شرایط لغو و عدم حضور {d.sellerParty.displayName}</h3>
          {changedNotice ? (
            <p className={styles.changed} role="alert" data-testid="terms-changed">
              شرایط این متخصص پس از نمایش قبلی تغییر کرده است. شرایط جدید را بخوانید و دوباره تأیید کنید.
            </p>
          ) : null}
          <TermsBlock terms={d.outcome} copyBody={d.outcome.copy.body} />
          <label className={styles.accept}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => onAcceptedChange(e.target.checked)}
              data-testid="terms-accept"
            />
            <span>این شرایط را خواندم و می‌پذیرم.</span>
          </label>
        </>
      ) : (
        <p className={styles.note} data-testid="terms-none">
          این متخصص سیاست لغو و عدم حضور ثبت‌شده‌ای ندارد؛ شرایطی برای پذیرش وجود ندارد.
        </p>
      )}
    </div>
  );
}

/** Booking details: the terms this booking was actually accepted under. */
export function AcceptedTermsPanel({ api, bookingId }: { api: ApiClient; bookingId: string }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; terms: AcceptedTerms }>({
    status: 'loading',
  });
  useEffect(() => {
    let cancelled = false;
    loadAcceptedTerms(api, bookingId)
      .then((res) => {
        if (!cancelled && res.data) setState({ status: 'ready', terms: res.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, bookingId]);

  if (state.status === 'loading') return <p className={styles.note}>در حال دریافت شرایط…</p>;
  if (state.status === 'error') return <p className={`${styles.note} ${styles.error}`}>شرایط این رزرو دریافت نشد.</p>;
  const t = state.terms;
  if (!t.governed) {
    return (
      <p className={styles.note} data-testid="accepted-terms-none">
        برای این رزرو سیاست لغو و عدم حضوری ثبت و پذیرفته نشده است.
      </p>
    );
  }
  return (
    <div className={styles.panel} data-testid="accepted-terms">
      <p className={styles.note}>
        پذیرفته‌شده در {tehranDateTime(t.acceptedAt)} — نسخهٔ سیاست {toPersianDigits(String(t.policy.policyVersion))}، نسخهٔ متن{' '}
        {toPersianDigits(String(t.copy.copyVersion))}
      </p>
      <TermsBlock terms={t.terms} copyBody={t.copy.body} />
    </div>
  );
}
