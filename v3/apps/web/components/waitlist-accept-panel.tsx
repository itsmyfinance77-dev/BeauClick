'use client';

/**
 * DEMO BRANCH ONLY (demo remediation F-8) — accepting a waitlist offer is a
 * checkout.
 *
 * The offer is shown with the server's own disclosure for (professional,
 * offered time, service): the amounts and, for a governed seller, the terms
 * with an UNTICKED box — exactly the checkout on a profile page. Nothing is
 * sent until the customer confirms; the server then books, creates the order
 * and returns the bank redirect (or confirms when nothing is collected online).
 * One idempotency key per panel, reused by a retry of the same attempt.
 */
import { useState } from 'react';
import { formatToman } from '@beauclick/persian-utils';

import type { ApiClient } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-client';
import { sameAcceptance } from '@/lib/checkout-terms';
import { acceptWaitlistOffer, type WaitlistEntry } from '@/lib/phase4-api';
import { CheckoutTermsPanel, checkoutReady, useCheckoutDisclosure } from './checkout-terms';
import { Button } from './ui';
import styles from './checkout-terms.module.css';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function WaitlistAcceptPanel({
  api,
  entry,
  onDone,
  onCancel,
}: {
  api: ApiClient;
  entry: WaitlistEntry;
  /** After a refusal the page reloads the list (the entry may now be `missed`). `bookings` when there is nothing to pay online. */
  onDone: (outcome: 'refused' | 'bookings') => void;
  onCancel: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [termsChanged, setTermsChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptKey] = useState<string>(newKey);

  const { state: disclosure, reload } = useCheckoutDisclosure(api, {
    professionalId: entry.professionalId,
    serviceId: entry.serviceId,
    slotId: entry.offeredSlotId,
    enabled: Boolean(entry.serviceId && entry.offeredSlotId),
  });

  async function submit() {
    // With a service the disclosure must be loaded and, when required, ticked;
    // an any-service entry has nothing to disclose here and the server decides.
    const disclosed = disclosure.status === 'ready' ? disclosure.disclosure : null;
    if (entry.serviceId && (!disclosed || !checkoutReady(disclosure, accepted))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await acceptWaitlistOffer(
        api,
        entry.id,
        disclosed && disclosed.acceptanceRequired && disclosed.acceptance ? { acceptedPolicy: disclosed.acceptance } : {},
        attemptKey,
      );
      const url = res.data?.payment.redirectUrl;
      if (url) {
        window.location.href = url;
        return;
      }
      onDone('bookings');
    } catch (err) {
      if (disclosed && err instanceof ApiRequestError && err.code === 'SERVICE_UNAVAILABLE_FOR_SALE') {
        const fresh = await reload();
        if (fresh && (fresh.acceptanceRequired !== disclosed.acceptanceRequired || !sameAcceptance(fresh.acceptance, disclosed.acceptance))) {
          setAccepted(false);
          setTermsChanged(true);
          setBusy(false);
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'پذیرش این پیشنهاد ممکن نشد.');
      setBusy(false);
      if (err instanceof ApiRequestError && err.status === 409) onDone('refused');
    }
  }

  return (
    <div className={styles.panel} data-testid="waitlist-accept">
      <h3 className={styles.heading}>پذیرش پیشنهاد و پرداخت</h3>
      {disclosure.status === 'ready' ? (
        <p className={styles.note} data-testid="waitlist-amount">
          مبلغ این نوبت: <strong>{formatToman(disclosure.disclosure.amounts.serviceTotalToman)} تومان</strong>. با تأیید، رزرو ثبت و به درگاه
          پرداخت منتقل می‌شوید؛ نوبت تا پایان مهلت پرداخت برای شما نگه داشته می‌شود.
        </p>
      ) : null}
      {!entry.serviceId ? (
        <p className={styles.note}>برای این عضویت خدمت مشخصی ثبت نشده است؛ نوبت با خدمتِ همین زمان رزرو می‌شود.</p>
      ) : null}
      <CheckoutTermsPanel
        state={disclosure}
        accepted={accepted}
        onAcceptedChange={(v) => {
          setAccepted(v);
          if (v) setTermsChanged(false);
        }}
        changedNotice={termsChanged}
      />
      {error ? (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.amounts}>
        <Button
          inline
          variant="primary"
          disabled={busy || (entry.serviceId ? !checkoutReady(disclosure, accepted) : false)}
          onClick={() => void submit()}
          data-testid="waitlist-pay"
        >
          {busy ? 'در حال ثبت…' : 'پرداخت و ثبت رزرو'}
        </Button>
        <Button inline variant="ghost" disabled={busy} onClick={onCancel}>
          بازگشت
        </Button>
      </div>
    </div>
  );
}
