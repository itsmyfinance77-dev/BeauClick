'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { formatZonedFullDate, formatZonedTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { ConfirmDialog, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import {
  NO_SHOW_STATEMENT_MAX_LENGTH,
  markNoShow,
  noShowState,
  type BookingSummary,
  type NoShowState,
  type ProfessionalBookingSummary,
} from '@/lib/pro-api';
import styles from './outcome-panel.module.css';

/**
 * The seller's no-show declaration for ONE booking — screen 49 §1 with its
 * reviewer corrections, V3.3 #212, over `#42d-read` (#201).
 *
 * ## Mounted only when its row is opened
 *
 * The read route is per booking and `/pro/bookings` is a list, so this panel
 * is rendered only while its row's toggle is open and it reads on mount. A
 * closed row has fetched nothing (#212 acceptance 1).
 *
 * ## Every decision is the server's
 *
 * - whether the control exists at all: `declarationPermitted`;
 * - whether the statement is required: `statementRequired` (reviewer
 *   correction C2 — the server refuses an empty one on a governed booking);
 * - the grace value, which is SAID when the booking's terms carry one and
 *   never added to a clock. No permitted instant crosses the wire and none is
 *   computed here, so there is nothing to count down to.
 *
 * ## An ungoverned booking gets no statement field
 *
 * The spec leaves the statement optional there, but `BookingService.markNoShow`
 * does not store a statement on the ungoverned path at all — it only moves the
 * booking. A field whose text is silently discarded would tell the seller
 * something false, so it is not offered.
 *
 * ## Evidence minimality
 *
 * One free-text statement and nothing else: no photo, no location, no health
 * field, no completeness meter, and nothing implying a longer statement helps.
 */
export function NoShowPanel({
  booking,
  onDeclared,
  onStale,
}: {
  booking: ProfessionalBookingSummary;
  /**
   * The server's returned booking after a declaration it accepted. The page
   * announces the result: a declared booking changes tab, and this panel is
   * remounted there, so an announcement made here would be lost.
   */
  onDeclared: (updated: BookingSummary) => void;
  /** The list on screen is out of date (the booking moved on underneath it). */
  onStale: () => void;
}) {
  const { api } = useAuth();
  const describedId = useId();

  const [state, setState] = useState<NoShowState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [statement, setStatement] = useState('');
  const [statementError, setStatementError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const read = useCallback(async () => {
    setReadError(null);
    try {
      const res = await noShowState(api, booking.id);
      setState(res.data ?? null);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'وضعیت عدم حضور خوانده نشد.');
    }
  }, [api, booking.id]);

  useEffect(() => {
    void read();
  }, [read]);

  const statementMissing = state?.statementRequired === true && statement.trim().length === 0;

  async function declare() {
    if (!state) return;
    if (statementMissing) {
      setStatementError('توضیح را بنویسید.');
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const res = await markNoShow(api, booking.id, state.statementRequired ? statement : undefined);
      setConfirming(false);
      await read();
      if (res.data) onDeclared(res.data);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : null;
      if (code === 'NO_SHOW_STATEMENT_REQUIRED') {
        // Unreachable while the form requires the field first; kept honest
        // rather than swallowed, and the dialog stays open to fix it.
        setStatementError('توضیح را بنویسید.');
        return;
      }
      setConfirming(false);
      if (code === 'INVALID_BOOKING_TRANSITION') {
        // The moment has not arrived, or the booking moved on (cancelled,
        // completed, declared from another tab). Re-read both, do not guess.
        setRefusal('ثبت عدم حضور برای این نوبت ممکن نشد: یا زمان آن هنوز نرسیده، یا وضعیت نوبت تغییر کرده است.');
        onStale();
        await read();
      } else {
        setRefusal(err instanceof Error ? err.message : 'ثبت عدم حضور انجام نشد.');
      }
    } finally {
      setBusy(false);
    }
  }

  function openDialog() {
    setStatement('');
    setStatementError(null);
    setRefusal(null);
    setConfirming(true);
  }

  let content: ReactNode;
  if (readError) {
    content = <ErrorState message={readError} onRetry={() => void read()} />;
  } else if (!state) {
    content = <LoadingState label="در حال خواندن وضعیت عدم حضور…" lines={2} />;
  } else if (state.declaration) {
    const at = new Date(state.declaration.declaredAt);
    content = (
      <div className={styles.closed} data-testid="no-show-declared">
        <p className={styles.title}>عدم حضور ثبت شده است</p>
        <p className={styles.text}>
          {formatZonedFullDate(at)} ساعت <span className={styles.clock}>{formatZonedTime(at)}</span>
        </p>
        {state.declaration.statement ? (
          <div className={styles.statement}>
            <p className={styles.label}>توضیح شما</p>
            <p className={styles.quote}>{state.declaration.statement}</p>
          </div>
        ) : null}
        <p className={styles.done}>این ثبت تغییرناپذیر است و کاری باقی نمانده است.</p>
      </div>
    );
  } else if (booking.status === 'no_show') {
    // A declaration from before #161 left no record row; the status is the fact.
    content = (
      <div className={styles.closed} data-testid="no-show-declared">
        <p className={styles.title}>این نوبت به‌عنوان عدم حضور ثبت شده است</p>
        <p className={styles.done}>کاری باقی نمانده است.</p>
      </div>
    );
  } else if (state.declarationPermitted) {
    content = (
      <div className={styles.open} data-testid="no-show-permitted">
        <p className={styles.title}>مشتری نیامد؟</p>
        <p className={styles.text}>اعلام عدم حضور یک ثبت تغییرناپذیر است و به‌خودی‌خود هیچ پولی را جابه‌جا نمی‌کند.</p>
        <div className={styles.actions}>
          <Button type="button" variant="danger" inline onClick={openDialog}>
            اعلام عدم حضور
          </Button>
        </div>
      </div>
    );
  } else if (booking.status === 'confirmed') {
    // A sentence stands where the control would be — never a disabled button
    // and never a timer (spec 49 §1). The grace value is the booking's own
    // when it has one, and otherwise the rule is stated without a number.
    content = (
      <p role="status" className={styles.notice} data-testid="no-show-too-early">
        {state.governed && state.graceMinutes !== null
          ? `اعلام عدم حضور برای این نوبت هنوز ممکن نیست. پس از گذشت ${toPersianDigits(state.graceMinutes)} دقیقه مهلت ارفاق از شروع نوبت، همین‌جا فعال می‌شود.`
          : 'اعلام عدم حضور برای این نوبت هنوز ممکن نیست. پس از پایان زمان نوبت، همین‌جا فعال می‌شود.'}
      </p>
    );
  } else {
    // Not "not yet": a booking that is no longer confirmed can never be declared.
    content = (
      <p className={styles.notice} data-testid="no-show-not-applicable">
        این نوبت دیگر در وضعیت «تأیید شده» نیست و عدم حضور برای آن ثبت نمی‌شود.
      </p>
    );
  }

  return (
    <div className={styles.panel}>
      {refusal ? <Alert>{refusal}</Alert> : null}
      {content}

      <ConfirmDialog
        open={confirming}
        title="عدم حضور را اعلام می‌کنید"
        tone="danger"
        confirmLabel="اعلام می‌کنم"
        busy={busy}
        onConfirm={() => void declare()}
        onCancel={() => setConfirming(false)}
        describedById={describedId}
        body={
          state ? (
            <>
              <div id={describedId} className={styles.columns} data-testid="no-show-consequences">
                <section className={styles.column} aria-labelledby={`${describedId}-does`}>
                  <h3 id={`${describedId}-does`} className={styles.columnTitle}>
                    این اعلام چه می‌کند
                  </h3>
                  <ul className={styles.points}>
                    {state.governed ? (
                      <>
                        <li>یک ثبت دائمی می‌سازد: یک کنشگر، یک لحظه.</li>
                        <li>پنجرهٔ اعتراض مشتری را باز می‌کند و به او اطلاع داده می‌شود.</li>
                      </>
                    ) : (
                      <li>این نوبت را به‌عنوان «عدم حضور» ثبت می‌کند.</li>
                    )}
                  </ul>
                </section>
                <section className={styles.column} aria-labelledby={`${describedId}-not`}>
                  <h3 id={`${describedId}-not`} className={styles.columnTitle}>
                    چه نمی‌کند
                  </h3>
                  <ul className={styles.points}>
                    <li>
                      به‌خودی‌خود هیچ مبلغی را برنمی‌دارد و نگه نمی‌دارد.
                      {state.governed ? ' پیامد پرداخت را بعداً شرایط خود این نوبت تعیین می‌کند، نه این اعلام.' : ''}
                    </li>
                    <li>هیچ بازپرداختی را لغو نمی‌کند.</li>
                    <li>پس گرفته نمی‌شود — این ثبت تغییرناپذیر است.</li>
                  </ul>
                </section>
              </div>

              {state.statementRequired ? (
                <Textarea
                  label="توضیح — الزامی برای این رزرو"
                  rows={3}
                  required
                  maxLength={NO_SHOW_STATEMENT_MAX_LENGTH}
                  hint={`بین ۱ تا ${toPersianDigits(NO_SHOW_STATEMENT_MAX_LENGTH)} نویسه؛ کوتاه کافی است. ${toPersianDigits(statement.length)} / ${toPersianDigits(NO_SHOW_STATEMENT_MAX_LENGTH)}`}
                  error={statementError}
                  value={statement}
                  disabled={busy}
                  onChange={(e) => {
                    setStatement(e.target.value);
                    if (statementError && e.target.value.trim()) setStatementError(null);
                  }}
                />
              ) : null}
            </>
          ) : null
        }
      />
    </div>
  );
}
