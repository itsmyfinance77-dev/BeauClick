'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatToman, formatZonedFullDate } from '@beauclick/persian-utils';
import { Alert, Button, LoadingState } from '@/components/ui';
import { Select } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { bookingApi, slotTimeLabel, type AvailableSlot, type BookingSummary, type CustomerRemedyView } from '@/lib/booking-api';
import styles from './outcome-panel.module.css';

/** Which of the remedy's shapes a server answer is. Pure, so a test can pin every row of it. */
export type RemedyStage = 'closed_reschedule' | 'closed_refund' | 'refund_failed' | 'in_progress';

export function remedyStage(view: CustomerRemedyView): RemedyStage {
  if (view.chosen === 'reschedule') return 'closed_reschedule';
  if (view.executionStatus === 'executed') return 'closed_refund';
  if (view.executionStatus === 'failed') return 'refund_failed';
  // `pending`, `manual_required`, or no live decision yet: the default refund
  // is still the resolution and has not finished. Whether it can still be
  // swapped is `rescheduleStillAvailable`, read separately and never inferred.
  return 'in_progress';
}

function refundAmount(view: CustomerRemedyView): ReactNode {
  if (view.refundToman === null) return null;
  return (
    <p className={styles.amount} data-testid="remedy-amount">
      <span className={styles.figure}>{formatToman(Number(view.refundToman))}</span> تومان
    </p>
  );
}

/**
 * The customer's remedy for ONE booking — screen 49 §3, V3.3 #212, over
 * `#42d-read` (#201).
 *
 * ## Mounted only when its row is opened
 *
 * Same discipline as the seller's panel: the read is per booking and the page
 * is a list, so nothing is read until the customer opens this row. The slot
 * list for the reschedule override is read later still — only when the
 * customer asks for it.
 *
 * ## The default is already applied
 *
 * There is no "accept the refund" button. `resolvedBy: 'default'` means the
 * refund is the resolution already, and doing nothing loses the customer
 * nothing. The only control is the free-reschedule override, present exactly
 * while the server's `rescheduleStillAvailable` is `true` — bounded by the
 * refund's own execution status, never by a timer, so no countdown exists.
 *
 * ## States that are not failures
 *
 * `REMEDY_NOT_OFFERED` is the ordinary answer for most cancelled bookings (the
 * customer cancelled it themselves, say) and renders as a plain sentence. A
 * closed resolution renders with nothing left to do, and a repeated request
 * answers with the same resolution, so it renders as this same screen.
 */
export function RemedyPanel({
  booking,
  onRescheduled,
}: {
  booking: BookingSummary;
  /** The booking now sits on a new slot and is confirmed again; the list is stale. */
  onRescheduled: () => void;
}) {
  const { api } = useAuth();

  const [view, setView] = useState<CustomerRemedyView | null>(null);
  const [notOffered, setNotOffered] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [picking, setPicking] = useState(false);
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slotId, setSlotId] = useState('');
  const [slotError, setSlotError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const read = useCallback(async () => {
    setReadError(null);
    try {
      const res = await bookingApi.remedyState(api, booking.id);
      setView(res.data ?? null);
      setNotOffered(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'REMEDY_NOT_OFFERED') {
        setNotOffered(true);
        setView(null);
        return;
      }
      setReadError(err instanceof Error ? err.message : 'وضعیت جبران خوانده نشد.');
    }
  }, [api, booking.id]);

  useEffect(() => {
    void read();
  }, [read]);

  const loadSlots = useCallback(async () => {
    setSlotsError(null);
    setSlots(null);
    try {
      const res = await bookingApi.listAvailability(api, booking.professionalId, booking.serviceId);
      // The current slot is the one that was cancelled; the server re-checks
      // claimability on the POST, this only avoids offering a certain refusal.
      setSlots((res.data ?? []).filter((slot) => slot.id !== booking.slotId));
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : 'زمان‌های آزاد بارگذاری نشد.');
    }
  }, [api, booking.professionalId, booking.serviceId, booking.slotId]);

  function startPicking() {
    setPicking(true);
    setSlotId('');
    setSlotError(null);
    setRefusal(null);
    void loadSlots();
  }

  async function reschedule() {
    if (!slotId) {
      setSlotError('زمان تازه را انتخاب کنید.');
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await bookingApi.resolveRemedy(api, booking.id, { choice: 'reschedule', newSlotId: slotId });
      setPicking(false);
      await read();
      onRescheduled();
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : null;
      if (code === 'REMEDY_REFUND_ALREADY_EXECUTED') {
        // The refund finished while this screen was open. Not an error: the
        // closed resolution is the answer, so re-read and show it.
        setPicking(false);
        setNote('بازپرداخت در همین فاصله انجام شد.');
        await read();
      } else if (code === 'REMEDY_NOT_OFFERED') {
        setPicking(false);
        await read();
      } else {
        // Most often the slot was taken by someone else a moment ago.
        setRefusal(err instanceof Error ? err.message : 'ثبت نوبت تازه انجام نشد.');
        void loadSlots();
      }
    } finally {
      setBusy(false);
    }
  }

  let content: ReactNode;
  if (readError) {
    content = (
      <div className={styles.failure}>
        <Alert>وضعیت جبران خوانده نشد. این خطا فقط دربارهٔ خواندن وضعیت است و چیزی را تغییر نمی‌دهد.</Alert>
        <Button type="button" variant="ghost" inline onClick={() => void read()}>
          تلاش دوباره
        </Button>
      </div>
    );
  } else if (notOffered) {
    content = (
      <p className={styles.notice} data-testid="remedy-not-offered">
        برای این رزرو گزینهٔ جبرانی وجود ندارد.
      </p>
    );
  } else if (!view) {
    content = <LoadingState label="در حال خواندن وضعیت جبران…" lines={2} />;
  } else {
    const stage = remedyStage(view);
    if (stage === 'closed_reschedule') {
      content = (
        <div className={styles.closed} data-testid="remedy-closed-reschedule">
          <p className={styles.title}>نوبت تازه انتخاب شد</p>
          <p className={styles.text}>جبران شما: یک نوبت رایگان تازه. بازپرداخت انجام نمی‌شود، چون خودتان آن را جایگزین کردید.</p>
          <p className={styles.done}>کاری باقی نمانده است.</p>
        </div>
      );
    } else if (stage === 'closed_refund') {
      content = (
        <div className={styles.closed} data-testid="remedy-closed-refund">
          <p className={styles.title}>بازپرداخت انجام شد</p>
          {view.refundToman === '0' ? (
            <p className={styles.text}>مبلغی برای بازگرداندن باقی نبود.</p>
          ) : (
            <>
              <p className={styles.text}>بازپرداخت کامل انجام شد.</p>
              {refundAmount(view)}
            </>
          )}
          <p className={styles.done}>گزینهٔ نوبت تازه دیگر در دسترس نیست و کاری باقی نمانده است.</p>
        </div>
      );
    } else if (stage === 'refund_failed') {
      content = (
        <div className={styles.closed} data-testid="remedy-refund-failed">
          <p className={styles.title}>بازپرداخت هنوز تکمیل نشده است</p>
          <p className={styles.text}>اجرای بازپرداخت این رزرو با مشکل روبه‌رو شد و هنوز انجام نشده است.</p>
          {refundAmount(view)}
        </div>
      );
    } else {
      content = (
        <div className={styles.open} data-testid="remedy-in-progress">
          <p className={styles.title}>بازپرداخت کامل در جریان است</p>
          <p className={styles.text}>
            لازم نیست کاری بکنید. کل مبلغی که پرداخت کرده‌اید به شما بازمی‌گردد. اگر کاری نکنید، همین اتفاق می‌افتد.
          </p>
          {refundAmount(view)}

          {view.rescheduleStillAvailable ? (
            <div className={styles.override} data-testid="remedy-override">
              <p className={styles.subtitle}>ترجیح می‌دهید به‌جایش نوبت تازه بگیرید؟</p>
              <p className={styles.text}>
                تا وقتی بازپرداخت اجرا نشده، می‌توانید آن را با یک نوبت رایگان دیگر نزد همین متخصص عوض کنید. این تنها
                گزینهٔ جایگزین است.
              </p>
              {!picking ? (
                <div className={styles.actions}>
                  <Button type="button" variant="ghost" inline onClick={startPicking}>
                    به‌جای بازپرداخت، نوبت تازه می‌خواهم
                  </Button>
                </div>
              ) : slotsError ? (
                <div className={styles.failure}>
                  <Alert>{slotsError}</Alert>
                  <Button type="button" variant="ghost" inline onClick={() => void loadSlots()}>
                    تلاش دوباره
                  </Button>
                </div>
              ) : slots === null ? (
                <LoadingState label="در حال بارگذاری زمان‌های آزاد…" lines={1} />
              ) : slots.length === 0 ? (
                <>
                  <p className={styles.notice}>این متخصص فعلاً زمان آزادی ندارد. بازپرداخت همچنان در جریان است.</p>
                  <div className={styles.actions}>
                    <Button type="button" variant="ghost" inline onClick={() => setPicking(false)}>
                      بستن
                    </Button>
                  </div>
                </>
              ) : (
                <div className={styles.picker} data-testid="remedy-slot-picker">
                  <Select
                    label="زمان تازه"
                    value={slotId}
                    error={slotError}
                    disabled={busy}
                    onChange={(e) => {
                      setSlotId(e.target.value);
                      if (e.target.value) setSlotError(null);
                    }}
                  >
                    <option value="">انتخاب کنید</option>
                    {slots.map((slot) => (
                      <option key={slot.id} value={slot.id}>
                        {`${formatZonedFullDate(new Date(slot.startAt))} — ${slotTimeLabel(slot.startAt)}`}
                      </option>
                    ))}
                  </Select>
                  <p className={styles.text}>با ثبت نوبت تازه، بازپرداخت انجام نمی‌شود و این انتخاب بازگشت ندارد.</p>
                  {refusal ? <Alert>{refusal}</Alert> : null}
                  <div className={styles.actions}>
                    <Button type="button" inline loading={busy} onClick={() => void reschedule()}>
                      ثبت نوبت تازه
                    </Button>
                    <Button type="button" variant="ghost" inline disabled={busy} onClick={() => setPicking(false)}>
                      انصراف
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      );
    }
  }

  return (
    <div className={styles.panel}>
      {note ? <Alert tone="info">{note}</Alert> : null}
      {content}
    </div>
  );
}
