'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { formatFullJalaliDate, formatToman, toPersianDigits } from '@beauclick/persian-utils';
import {
  isPaymentFailureReason,
  isRetryableFailureReason,
  statusCarriesAReason,
  type PaymentFailureReason,
} from '@beauclick/payment-contract';

import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { loginHrefReturningTo } from '@/lib/safe-return';
import { bookingApi, type OrderDetail } from '@/lib/booking-api';

type Tone = 'success' | 'error' | 'warning';

/**
 * The shape marker for each outcome.
 *
 * `aria-hidden`, because the heading beside it already says the same thing in
 * words — a screen reader announcing "check mark" before "پرداخت انجام شد" is
 * noise. Its job is for sighted users: **shape, not only colour, carries the
 * distinction**, so the page still reads correctly to somebody who cannot tell
 * the amber from the red. A text glyph rather than an asset, because this
 * product ships no icon set and adding one is a pipeline decision nobody has
 * made.
 */
const TONE_GLYPH: Record<Tone, string> = { success: '✓', error: '✕', warning: '⚠' };

const OUTCOME_COPY: Record<string, { tone: Tone; title: string; body: string }> = {
  succeeded: {
    tone: 'success',
    title: 'پرداخت انجام شد',
    body: 'رزرو شما تأیید شد. جزئیات در ادامه آمده است.',
  },
  replayed: {
    tone: 'success',
    title: 'این پرداخت قبلاً ثبت شده بود',
    body: 'نگران نباشید؛ مبلغ فقط یک بار از شما دریافت شده است.',
  },
  failed: {
    tone: 'error',
    title: 'پرداخت انجام نشد',
    body: 'مبلغی از حساب شما کسر نشده است. می‌توانید دوباره تلاش کنید.',
  },
  /**
   * The tone changed from `error` to `warning` in the Phase F design pass, and
   * the reasoning is worth keeping: the customer did nothing wrong. Their slot
   * expired before the payment completed and the money came back
   * automatically. Rendering that in the error colour presents a correction
   * the platform made FOR them as a problem they caused.
   *
   * `warning` rides the existing measured `warning` / `warning-soft` token
   * pair — no new token, no new component.
   */
  refunded: {
    tone: 'warning',
    title: 'پرداخت برگشت داده شد',
    body: 'زمان رزرو پیش از تکمیل پرداخت منقضی شد و مبلغ به‌صورت خودکار بازگردانده شد.',
  },
  /**
   * The API emits this status (checkout.controller.ts) when a SECOND real
   * charge landed on an already-paid order and was automatically refunded.
   *
   * It was missing here once, so it fell through to `failed` — which tells the
   * customer "مبلغی از حساب شما کسر نشده است". That is the opposite of what
   * happened: they were charged twice, and the second charge was given back.
   */
  duplicate_refunded: {
    tone: 'success',
    title: 'رزرو شما تأیید شد',
    body: 'به دلیل یک پرداخت تکراری، مبلغ دوم به‌صورت خودکار به حساب شما بازگردانده شد. بازگشت وجه معمولاً طی ۷۲ ساعت در صورت‌حساب بانکی شما ثبت می‌شود.',
  },
  /**
   * The gateway could not be reached, or did not answer definitively
   * (`VerifyOutcome = 'unknown'`). The server wrote NOTHING, so the payment is
   * genuinely undecided.
   *
   * **The previous copy promised something no code does.** It said any amount
   * deducted "به‌صورت خودکار تعیین تکلیف می‌شود" — automatically resolved. There
   * is no reconciliation sweep. `V3.1_PHASE_F_IMPLEMENTATION.md` §8 records
   * that one was deliberately NOT built, because it would require guessing at
   * gateway settlement semantics nobody has yet. So the sentence described a
   * mechanism that does not exist, to a customer who might be relying on it,
   * about their money.
   *
   * The corrected copy says exactly three things and promises nothing: the
   * result is unknown, do not pay again, and go and look at your bookings —
   * plus who to contact if the two disagree. No timing, no guarantee, and no
   * verb that implies a process is running.
   */
  unresolved: {
    tone: 'warning',
    title: 'وضعیت پرداخت هنوز مشخص نیست',
    body: 'ارتباط با بانک برای تأیید این پرداخت برقرار نشد و نتیجهٔ نهایی هنوز معلوم نیست. ممکن است مبلغ از حساب شما کسر شده باشد یا نشده باشد. لطفاً دوباره پرداخت نکنید و به‌جای آن وضعیت این رزرو را از صفحهٔ «رزروهای من» بررسی کنید. اگر پس از بررسی، مبلغی کسر شده اما رزرو تأیید نشده بود، با پشتیبانی تماس بگیرید.',
  },
};

/**
 * `QA-21`: why the payment did not succeed, from the `reason` query parameter
 * the redirect contract carries.
 *
 * Keyed by the server's closed public vocabulary. The KEYS come from
 * `@beauclick/payment-contract` — a dependency-free package the server's
 * payment domain re-exports — so the page and the server cannot disagree about
 * which reasons exist or which permit a retry. Only the Persian copy lives
 * here, because copy is this file's job and policy is not.
 */
const FAILURE_REASON_COPY: Record<PaymentFailureReason, string> = {
  cancelled_by_user:
    'شما پرداخت را در صفحهٔ بانک لغو کردید. مبلغی از حساب شما کسر نشده است و می‌توانید دوباره تلاش کنید.',
  declined:
    'بانک این تراکنش را تأیید نکرد. مبلغی کسر نشده است؛ لطفاً موجودی یا محدودیت‌های کارت خود را بررسی کنید یا با کارت دیگری تلاش کنید.',
  expired: 'مهلت پرداخت این سفارش به پایان رسید. مبلغی از حساب شما کسر نشده است.',
  not_completed: 'پرداخت در صفحهٔ بانک تکمیل نشد. مبلغی کسر نشده است و می‌توانید دوباره تلاش کنید.',
  unknown_reference:
    'این تراکنش نزد درگاه پرداخت شناسایی نشد. اگر مبلغی از حساب شما کسر شده است، با پشتیبانی تماس بگیرید.',
  /**
   * A gateway-reported success whose amount or currency disagreed with the
   * order — a security event, not an ordinary decline. The customer is told
   * plainly that support must look, and is NOT invited to retry.
   */
  amount_mismatch:
    'مبلغ تأییدشده توسط درگاه با مبلغ سفارش مطابقت نداشت و پرداخت ثبت نشد. این یک رویداد امنیتی است؛ پیش از تلاش دوباره با پشتیبانی تماس بگیرید.',
  unresolved: 'نتیجهٔ پرداخت از بانک دریافت نشد. تا مشخص شدن وضعیت، دوباره پرداخت نکنید.',
  /**
   * Also corrected in the Phase F design pass. The previous copy promised that
   * any deducted amount "به‌صورت خودکار بازگردانده می‌شود" — an automatic refund.
   * `gateway_error` is a DEFINITIVE failure: the gateway said the transaction
   * did not succeed, so by definition nothing was captured and there is
   * nothing to refund. Promising a refund for a case that should not occur is
   * a guarantee with no mechanism behind it, and it leaves a customer waiting
   * for money that was never taken.
   */
  gateway_error:
    'درگاه پرداخت خطایی گزارش کرد و پرداخت شما ثبت نشد. اگر با وجود این پیام مبلغی از حساب شما کسر شده، لطفاً با پشتیبانی تماس بگیرید.',
};

/**
 * Why the server refused a retry, in the customer's terms.
 *
 * Keyed by `PAYMENT_RETRY_REFUSALS`. Each one is actionable — a refusal that
 * only says "no" leaves the customer on the dead end this whole page exists to
 * get them out of.
 */
const RETRY_REFUSAL_COPY: Record<string, string> = {
  order_not_payable: 'وضعیت این سفارش تغییر کرده و دیگر قابل پرداخت نیست. لطفاً «رزروهای من» را بررسی کنید.',
  already_paid: 'این سفارش قبلاً پرداخت شده است. «رزروهای من» را بررسی کنید.',
  expired: 'مهلت پرداخت این سفارش به پایان رسیده است. لطفاً دوباره رزرو کنید.',
  verification_pending:
    'یک پرداخت برای این سفارش هنوز در حال بررسی است. لطفاً چند دقیقه صبر کنید و وضعیت رزرو را از «رزروهای من» بررسی کنید — تا مشخص شدن نتیجه دوباره پرداخت نکنید.',
  no_payment_started: 'پرداختی برای این سفارش آغاز نشده است. لطفاً از «رزروهای من» اقدام کنید.',
  not_retryable: 'امکان تلاش دوباره برای این پرداخت وجود ندارد. لطفاً با پشتیبانی تماس بگیرید.',
};

const NAV_LINK_STYLE = {
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  // The 44px baseline this project's own Button enforces. Same class of
  // finding as the 25px nav links and the 21px homepage CTA before them; this
  // is the surface a customer lands on straight after paying, on a phone.
  minHeight: 44,
} as const;

const ORDER_STATUS_FA: Record<string, string> = {
  pending: 'در انتظار پرداخت',
  paid: 'پرداخت‌شده',
  partially_refunded: 'بازگشت جزئی وجه',
  refunded: 'بازگشت کامل وجه',
  cancelled: 'لغو شده',
};

/**
 * The post-payment result and receipt.
 *
 * ## The security boundary, which no change here may weaken
 *
 * `status`, `reason`, and `orderId` are **presentation inputs, not payment
 * truth**. They choose which sentence to show and which order to ask about.
 * Every figure comes from re-fetching the order through the authenticated API,
 * so a customer who edits the query string sees a different headline over a
 * receipt that still tells the truth — and the authoritative state was decided
 * by a server-to-server verification long before this page rendered.
 *
 * Two rules enforce that here:
 *
 *  - a `reason` is read only for the statuses the server actually attaches one
 *    to (`failed`, `unresolved`). `?status=succeeded&reason=declined` must not
 *    produce a page that says both;
 *  - an unrecognised `status` or `reason` falls back to the generic `failed`
 *    copy rather than rendering nothing or echoing the raw value.
 */
function ResultContent() {
  const params = useSearchParams();
  const pathname = usePathname();
  const { api, status: authStatus } = useAuth();

  const outcome = params.get('status') ?? 'failed';
  const orderId = params.get('orderId') ?? '';

  /**
   * The failure reason, narrowed twice before it is used.
   *
   * First by STATUS: the server attaches a reason only to `failed` and
   * `unresolved`, so anything else carrying one had it appended by hand.
   * Then by VALUE: only a member of the closed public vocabulary counts.
   */
  const rawReason = params.get('reason');
  const failureReason: PaymentFailureReason | null =
    statusCarriesAReason(outcome) && isPaymentFailureReason(rawReason) ? rawReason : null;

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptAttempt, setReceiptAttempt] = useState(0);

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Move focus to the heading, once.
   *
   * Returning from the gateway is a full page navigation, so a keyboard or
   * screen-reader user would otherwise land at the top of the site navigation
   * and have to hunt for the outcome of their own payment. An empty dependency
   * array and a `tabIndex={-1}` target make this fire exactly once on mount —
   * re-running it on every render would yank focus back mid-interaction, which
   * is worse than not moving it at all.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // No order id, or no session: there is nothing this page may ask for. The
    // states below explain why rather than silently rendering no receipt.
    if (!orderId || authStatus !== 'authenticated') return;

    let cancelled = false;
    setReceiptError(null);
    bookingApi
      .getOrder(api, orderId)
      .then((res) => {
        if (!cancelled) setOrder(res.data);
      })
      .catch((err) => {
        if (!cancelled) setReceiptError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      });
    return () => {
      cancelled = true;
    };
    // `receiptAttempt` is the retry trigger: bumping it re-runs the fetch.
  }, [api, orderId, authStatus, receiptAttempt]);

  const copy = OUTCOME_COPY[outcome] ?? OUTCOME_COPY.failed;
  // The reason REPLACES the generic body when one survived both narrowings. It
  // never appends: two sentences explaining the same failure, one of them
  // generic, reads as though the page is unsure what happened.
  const body = failureReason ? FAILURE_REASON_COPY[failureReason] : copy.body;

  /**
   * Whether to OFFER a retry.
   *
   * `isRetryableFailureReason` is the same function the payment domain uses,
   * imported from the shared contract package rather than reimplemented — so
   * this cannot drift from the server's answer.
   *
   * It decides visibility and nothing else. The server re-derives eligibility
   * from its own stored failure code, its own order status, and its own open
   * attempts, and refuses regardless of what this page believed. A button that
   * should not be here produces a refusal, not a payment.
   */
  const canOfferRetry =
    outcome === 'failed' && isRetryableFailureReason(failureReason) && authStatus === 'authenticated' && orderId !== '';

  const handleRetry = useCallback(async () => {
    // Guarded here as well as by `disabled`: a fast double-press, a keyboard
    // repeat, or an assistive tool can deliver two activations before React
    // re-renders the disabled state.
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await bookingApi.retryOrderPayment(api, orderId);
      const redirectUrl = response.data?.redirectUrl;
      if (!redirectUrl) {
        setRetryError('آدرس پرداخت از سرور دریافت نشد. لطفاً دوباره تلاش کنید.');
        setRetrying(false);
        return;
      }
      // Navigate ONLY to what the server returned. This page never constructs
      // a gateway URL and never reads one from its own query string.
      window.location.assign(redirectUrl);
      // `retrying` is deliberately left set: the browser is leaving, and
      // re-enabling the button would offer a second payment during unload.
    } catch (err) {
      const refusal =
        err instanceof ApiRequestError && err.code === 'PAYMENT_RETRY_NOT_AVAILABLE'
          ? (err.details as { reason?: string } | undefined)?.reason
          : undefined;
      setRetryError(
        (refusal ? RETRY_REFUSAL_COPY[refusal] : undefined) ??
          (err instanceof ApiRequestError ? err.message : 'ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.'),
      );
      setRetrying(false);
    }
  }, [api, orderId, retrying]);

  const query = params.toString();
  const currentUrl = `${pathname}${query ? `?${query}` : ''}`;

  return (
    <section style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
      <Card>
        <h1
          ref={headingRef}
          tabIndex={-1}
          style={{ fontSize: 24, marginBlockEnd: 8, outline: 'none', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span aria-hidden="true">{TONE_GLYPH[copy.tone]}</span>
          {copy.title}
        </h1>

        <Alert tone={copy.tone}>{body}</Alert>

        {canOfferRetry ? (
          <div style={{ marginBlockEnd: 12 }}>
            <Button type="button" onClick={handleRetry} loading={retrying} inline>
              تلاش دوباره
            </Button>
          </div>
        ) : null}

        {/*
          A SEPARATE alert from the result banner. The design is explicit that
          the two must never share an element: a screen reader would otherwise
          re-announce the payment outcome every time a retry fails.
        */}
        {retryError ? <Alert tone="error">{retryError}</Alert> : null}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBlockStart: 8 }}>
          <Link href="/bookings" style={NAV_LINK_STYLE}>
            رزروهای من
          </Link>
          <Link href="/providers" style={NAV_LINK_STYLE}>
            بازگشت به فهرست متخصص‌ها
          </Link>
        </div>
      </Card>

      {/*
        Two states that previously rendered nothing at all — the receipt
        section simply vanished and the customer was left to guess why.
      */}
      {!orderId ? (
        <Card>
          <p style={{ margin: 0, color: 'var(--bc-color-ink-soft)' }}>
            شناسهٔ سفارش در این لینک موجود نیست؛ برای دیدن رسید، سفارش را از «رزروهای من» باز کنید.
          </p>
        </Card>
      ) : null}

      {orderId && authStatus === 'unauthenticated' ? (
        <Card>
          <p style={{ margin: 0, marginBlockEnd: 12, color: 'var(--bc-color-ink-soft)' }}>
            برای دیدن رسید کامل وارد شوید.
          </p>
          {/*
            Returns to THIS result URL after signing in, so the customer is not
            dropped on the dashboard wondering what happened to their payment.
            `loginHrefReturningTo` refuses anything that is not an absolute path
            on this origin — a login page is the most valuable place in a
            product to have an open redirect.
          */}
          <Link href={loginHrefReturningTo(currentUrl)} style={NAV_LINK_STYLE}>
            ورود
          </Link>
        </Card>
      ) : null}

      {orderId && authStatus === 'authenticated' && !order && !receiptError ? (
        <LoadingState label="در حال دریافت رسید…" />
      ) : null}

      {/*
        Was a bare `Alert` with no way forward. `ErrorState` already carries the
        retry affordance this needed; the page simply was not using it.
      */}
      {receiptError ? (
        <ErrorState
          message={receiptError}
          onRetry={() => {
            setReceiptError(null);
            setReceiptAttempt((n) => n + 1);
          }}
        />
      ) : null}

      {order ? (
        <Card>
          <h2 style={{ fontSize: 18, marginBlockEnd: 12 }}>رسید</h2>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <caption className="bc-visually-hidden">جزئیات مبلغ سفارش</caption>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <th scope="row" style={{ textAlign: 'start', fontWeight: 400, padding: '6px 0' }}>
                    {item.name}
                    {item.quantity > 1 ? ` × ${toPersianDigits(item.quantity)}` : ''}
                  </th>
                  <td style={{ textAlign: 'end', padding: '6px 0' }}>{formatToman(item.lineTotalToman)}</td>
                </tr>
              ))}

              {/* Every adjustment listed individually, exactly as the pricing
                  engine produced it at order time -- never folded into one
                  opaque "discount" figure, and never recomputed from today's
                  rules. */}
              {order.adjustments.map((adjustment) => (
                <tr key={adjustment.ruleKey + adjustment.label}>
                  <th
                    scope="row"
                    style={{ textAlign: 'start', fontWeight: 400, padding: '6px 0', color: 'var(--bc-color-ink-soft)' }}
                  >
                    {adjustment.label}
                  </th>
                  <td style={{ textAlign: 'end', padding: '6px 0', color: 'var(--bc-color-ink-soft)' }}>
                    {formatToman(adjustment.amountToman)}
                  </td>
                </tr>
              ))}

              <tr style={{ borderBlockStart: '1px solid var(--bc-color-line)' }}>
                <th scope="row" style={{ textAlign: 'start', padding: '10px 0', fontWeight: 700 }}>
                  مبلغ کل
                </th>
                <td style={{ textAlign: 'end', padding: '10px 0', fontWeight: 700 }}>
                  {formatToman(order.totalToman)} تومان
                </td>
              </tr>

              {/*
                V3.3 `#41a`. Shown ONLY when BeauClick did not collect the whole
                service price -- today never, because every order is
                `full_payment_online`. Rendering "پرداخت‌شده به بیوکلیک: X /
                پرداخت در محل: ۰" on every receipt would be noise that says
                nothing, so the split appears exactly when it means something.

                Both numbers come from the server's snapshot. Nothing here
                subtracts, and `مبلغ کل` above is untouched.
              */}
              {order.paymentSchedule.venueBalanceToman > 0 ? (
                <>
                  <tr>
                    <th scope="row" style={{ textAlign: 'start', padding: '6px 0', fontWeight: 400 }}>
                      پرداخت‌شده به بیوکلیک
                    </th>
                    <td style={{ textAlign: 'end', padding: '6px 0' }}>
                      {formatToman(order.paymentSchedule.platformCollectibleNowToman)} تومان
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={{ textAlign: 'start', padding: '6px 0', fontWeight: 400 }}>
                      قابل پرداخت در محل
                    </th>
                    <td style={{ textAlign: 'end', padding: '6px 0' }}>
                      {formatToman(order.paymentSchedule.venueBalanceToman)} تومان
                    </td>
                  </tr>
                </>
              ) : null}

              {order.refundedTotalToman > 0 ? (
                <tr>
                  <th
                    scope="row"
                    style={{ textAlign: 'start', padding: '6px 0', fontWeight: 400, color: 'var(--bc-color-error)' }}
                  >
                    مبلغ بازگردانده‌شده
                  </th>
                  <td style={{ textAlign: 'end', padding: '6px 0', color: 'var(--bc-color-error)' }}>
                    {formatToman(order.refundedTotalToman)} تومان
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <dl
            style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 13, marginBlockStart: 16 }}
          >
            <dt style={{ color: 'var(--bc-color-ink-faint)' }}>وضعیت سفارش</dt>
            <dd style={{ margin: 0 }}>{ORDER_STATUS_FA[order.status] ?? order.status}</dd>
            <dt style={{ color: 'var(--bc-color-ink-faint)' }}>تاریخ ثبت</dt>
            <dd style={{ margin: 0 }}>{formatFullJalaliDate(new Date(order.createdAt))}</dd>
          </dl>
        </Card>
      ) : null}
    </section>
  );
}

export default function CheckoutResultPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ResultContent />
    </Suspense>
  );
}
