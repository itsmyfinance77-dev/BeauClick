'use client';

/**
 * DEMO BRANCH ONLY (DEMO-DEC-001 part B) — never merged to master.
 *
 * The customer's durable replacement offer after a provider-side cancellation.
 * What it promises and what it does not are stated on screen, not implied:
 * the refund of the cancelled booking continues whatever the customer does here;
 * the offer is access to booking a replacement — not a reserved time, not the old
 * price; a replacement is a NEW booking with its own current terms and its own
 * payment, which may be taken before the earlier refund arrives.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatFullJalaliDate, formatToman, toPersianDigits } from '@beauclick/persian-utils';

import type { ApiClient } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-client';
import { bookingApi, groupSlotsByDay, slotTimeLabel, type AvailableSlot } from '@/lib/booking-api';
import { sameAcceptance } from '@/lib/checkout-terms';
import { REFUND_STATUS_FA, replacementApi, type ReplacementOfferView } from '@/lib/replacement-api';
import { CheckoutTermsPanel, checkoutReady, useCheckoutDisclosure } from './checkout-terms';
import { Button } from './ui';
import styles from './checkout-terms.module.css';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function ReplacementOfferPanel({ api, bookingId }: { api: ApiClient; bookingId: string }) {
  const [offer, setOffer] = useState<ReplacementOfferView | null | 'none' | 'error'>(null);
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [termsChanged, setTermsChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  // One idempotency key per attempt: created when a slot is chosen, reused for retries of THAT attempt.
  const [attemptKey, setAttemptKey] = useState<string>(newKey);

  const load = useCallback(async () => {
    try {
      const res = await replacementApi.view(api, bookingId);
      setOffer(res.data ?? 'error');
    } catch (err) {
      setOffer(err instanceof ApiRequestError && err.status === 404 ? 'none' : 'error');
    }
  }, [api, bookingId]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = offer && typeof offer === 'object' && offer.status === 'open' && offer.eligible && !offer.activeAttempt ? offer : null;
  useEffect(() => {
    if (!open) return;
    bookingApi
      .listAvailability(api, open.professionalId, open.serviceId)
      .then((res) => setSlots(res.data ?? []))
      .catch(() => setSlots([]));
  }, [api, open?.professionalId, open?.serviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { state: disclosure, reload } = useCheckoutDisclosure(api, {
    professionalId: open?.professionalId ?? '',
    serviceId: open?.serviceId ?? null,
    slotId,
    enabled: Boolean(open && slotId),
  });
  useEffect(() => {
    setAccepted(false);
    setTermsChanged(false);
    setAttemptKey(newKey());
  }, [slotId]);

  const days = useMemo(() => groupSlotsByDay(slots ?? []).slice(0, 5), [slots]);

  if (offer === null) return <p className={styles.note}>در حال دریافت پیشنهاد جایگزینی…</p>;
  if (offer === 'none')
    return <p className={styles.note} data-testid="replacement-none">برای این رزرو پیشنهاد جایگزینی وجود ندارد؛ این پیشنهاد فقط وقتی ساخته می‌شود که متخصص نوبت را لغو کند.</p>;
  if (offer === 'error') return <p className={`${styles.note} ${styles.error}`}>پیشنهاد جایگزینی دریافت نشد.</p>;

  const refundLine = offer.originalRefund ? (
    <p className={styles.note} data-testid="replacement-refund">
      بازپرداخت رزرو لغوشده ({formatToman(Number(offer.originalRefund.refundToman))} تومان) مستقل از این پیشنهاد ادامه دارد — وضعیت:{' '}
      {REFUND_STATUS_FA[offer.originalRefund.executionStatus] ?? offer.originalRefund.executionStatus}
    </p>
  ) : null;

  if (offer.status === 'used') {
    return (
      <div className={styles.panel} data-testid="replacement-used">
        <h3 className={styles.heading}>رزرو جایگزین ثبت شد</h3>
        <p className={styles.note}>از این پیشنهاد یک بار و با موفقیت استفاده شده است. رزرو لغوشده همچنان لغوشده باقی می‌ماند.</p>
        {refundLine}
      </div>
    );
  }
  if (offer.status === 'dismissed') {
    return (
      <div className={styles.panel} data-testid="replacement-dismissed">
        <p className={styles.note}>از پیشنهاد جایگزینی انصراف داده‌اید.</p>
        {refundLine}
      </div>
    );
  }
  if (!offer.eligible) {
    return (
      <div className={styles.panel} data-testid="replacement-unavailable">
        <p className={styles.note}>
          {offer.ineligibleReason === 'provider_inactive' ? 'این متخصص در حال حاضر فعال نیست' : 'این خدمت در حال حاضر ارائه نمی‌شود'}؛ فعلاً
          رزرو جایگزین ممکن نیست. پیشنهاد باز می‌ماند.
        </p>
        {refundLine}
      </div>
    );
  }
  if (offer.activeAttempt) {
    const attempt = offer.activeAttempt;
    return (
      <div className={styles.panel} data-testid="replacement-in-progress">
        <p className={styles.note}>
          یک رزرو جایگزین در انتظار پرداخت است. می‌توانید پرداخت را دوباره انجام دهید، یا آن را لغو کنید تا زمان دیگری انتخاب کنید. تا
          پایان مهلت نگه‌داری، پیشنهاد مصرف نمی‌شود.
        </p>
        {refundLine}
        {error ? <p className={`${styles.note} ${styles.error}`}>{error}</p> : null}
        <div className={styles.amounts}>
          {attempt.orderId ? (
            <Button inline variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await bookingApi.retryOrderPayment(api, attempt.orderId as string);
                  if (res.data?.redirectUrl) window.location.href = res.data.redirectUrl;
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'پرداخت دوباره ممکن نشد.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              پرداخت دوباره
            </Button>
          ) : null}
          <Button inline variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await bookingApi.cancelBooking(api, attempt.bookingId, 'انصراف از تلاش رزرو جایگزین');
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'لغو ممکن نشد.');
              } finally {
                setBusy(false);
              }
            }}
          >
            لغو این تلاش
          </Button>
        </div>
      </div>
    );
  }

  async function submit() {
    if (!open || !slotId || disclosure.status !== 'ready' || !checkoutReady(disclosure, accepted)) return;
    const disclosed = disclosure.disclosure;
    setBusy(true);
    setError(null);
    try {
      const res = await replacementApi.book(
        api,
        bookingId,
        { slotId, ...(disclosed.acceptanceRequired && disclosed.acceptance ? { acceptedPolicy: disclosed.acceptance } : {}) },
        attemptKey,
      );
      const url = res.data?.payment.redirectUrl;
      if (url) {
        window.location.href = url;
        return;
      }
      await load();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SERVICE_UNAVAILABLE_FOR_SALE') {
        const fresh = await reload();
        if (fresh && (fresh.acceptanceRequired !== disclosed.acceptanceRequired || !sameAcceptance(fresh.acceptance, disclosed.acceptance))) {
          setAccepted(false);
          setTermsChanged(true);
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'ثبت رزرو جایگزین ممکن نشد.');
      if (err instanceof ApiRequestError && err.status === 409) {
        await load();
        setSlotId(null);
        const again = await bookingApi.listAvailability(api, open.professionalId, open.serviceId).catch(() => null);
        if (again) setSlots(again.data ?? []);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel} data-testid="replacement-open">
      <h3 className={styles.heading}>پیشنهاد رزرو جایگزین</h3>
      <p className={styles.note}>
        متخصص این نوبت را لغو کرد. می‌توانید برای همان خدمت ({open?.service.name}) نزد همان متخصص ({open?.provider.displayName}) زمان دیگری
        رزرو کنید. این پیشنهاد دسترسی به رزرو جایگزین است، نه تضمین زمان یا قیمت قبلی. قیمت فعلی:{' '}
        <strong>{open?.service.currentPriceToman !== null && open ? formatToman(open.service.currentPriceToman ?? 0) : '—'} تومان</strong>
      </p>
      {refundLine}
      {error ? (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}

      {slots === null ? (
        <p className={styles.note}>در حال دریافت زمان‌های آزاد…</p>
      ) : days.length === 0 ? (
        <p className={styles.note} data-testid="replacement-no-slots">
          در حال حاضر زمان آزادی برای این خدمت نیست. پیشنهاد باز می‌ماند؛ بعداً سر بزنید.
        </p>
      ) : (
        <div className={styles.terms} data-testid="replacement-slots">
          {days.map((d) => (
            <div key={d.dayKey}>
              <p className={styles.note}>{formatFullJalaliDate(d.date)}</p>
              <div className={styles.amounts}>
                {d.slots.slice(0, 6).map((s) => (
                  <label key={s.id} className={styles.accept}>
                    <input type="radio" name={`replacement-${bookingId}`} checked={slotId === s.id} onChange={() => setSlotId(s.id)} />
                    <span>{toPersianDigits(slotTimeLabel(s.startAt))}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {slotId ? (
        <>
          <CheckoutTermsPanel
            state={disclosure}
            accepted={accepted}
            onAcceptedChange={(v) => {
              setAccepted(v);
              if (v) setTermsChanged(false);
            }}
            changedNotice={termsChanged}
          />
          <p className={styles.changed} data-testid="replacement-payment-disclosure">
            رزرو جایگزین، رزرو و پرداخت تازه‌ای است: مبلغ آن اکنون پرداخت می‌شود و ممکن است بازپرداخت رزرو لغوشده دیرتر به حساب شما برسد. هیچ
            مبلغی از رزرو قبلی منتقل نمی‌شود.
          </p>
          <Button inline variant="primary" disabled={busy || !checkoutReady(disclosure, accepted)} onClick={() => void submit()} data-testid="replacement-pay">
            {busy ? 'در حال ثبت…' : 'پرداخت و ثبت رزرو جایگزین'}
          </Button>
        </>
      ) : null}

      {confirmDismiss ? (
        <div className={styles.amounts}>
          <span>با انصراف، دیگر از این پیشنهاد نمی‌توانید استفاده کنید. بازپرداخت ادامه دارد.</span>
          <span />
          <Button inline variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await replacementApi.dismiss(api, bookingId);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'انصراف ثبت نشد.');
              } finally {
                setBusy(false);
                setConfirmDismiss(false);
              }
            }}
            data-testid="replacement-dismiss-confirm"
          >
            بله، انصراف می‌دهم
          </Button>
          <Button inline variant="ghost" onClick={() => setConfirmDismiss(false)}>
            بازگشت
          </Button>
        </div>
      ) : (
        <Button inline variant="ghost" onClick={() => setConfirmDismiss(true)} data-testid="replacement-dismiss">
          انصراف از پیشنهاد
        </Button>
      )}
    </div>
  );
}
