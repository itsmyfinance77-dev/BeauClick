'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatFullJalaliDate, formatToman, toPersianDigits } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { Alert, Card, LoadingState } from '@/components/ui';
import { bookingApi, type OrderDetail } from '@/lib/booking-api';

const OUTCOME_COPY: Record<string, { tone: 'success' | 'error'; title: string; body: string }> = {
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
  refunded: {
    tone: 'error',
    title: 'پرداخت برگشت داده شد',
    body: 'زمان رزرو پیش از تکمیل پرداخت منقضی شد و مبلغ به‌صورت خودکار بازگردانده شد.',
  },
  /**
   * The API emits this status (checkout.controller.ts) when a SECOND real
   * charge landed on an already-paid order and was automatically refunded.
   *
   * It was missing here, so it fell through to `failed` -- which tells the
   * customer "مبلغی از حساب شما کسر نشده است". That is the opposite of what
   * happened: they were charged twice, and the second charge was given back.
   * Telling someone no money moved when their statement will show two
   * debits and a credit is the worst possible copy for this state.
   */
  duplicate_refunded: {
    tone: 'success',
    title: 'رزرو شما تأیید شد',
    body: 'به دلیل یک پرداخت تکراری، مبلغ دوم به‌صورت خودکار به حساب شما بازگردانده شد. بازگشت وجه معمولاً طی ۷۲ ساعت در صورت‌حساب بانکی شما ثبت می‌شود.',
  },
};

/**
 * The post-payment result and receipt.
 *
 * The `status` in the URL is used only to choose which MESSAGE to show. Every
 * figure on this page comes from re-fetching the order from the API, so a
 * customer who edits the query string sees a reassuring headline over a
 * receipt that still tells the truth. The authoritative state was decided by
 * a server-to-server verification long before this page rendered.
 */
function ResultContent() {
  const params = useSearchParams();
  const { api, status: authStatus } = useAuth();
  const outcome = params.get('status') ?? 'failed';
  const orderId = params.get('orderId') ?? '';

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId || authStatus !== 'authenticated') return;
    let cancelled = false;
    bookingApi
      .getOrder(api, orderId)
      .then((res) => {
        if (!cancelled) setOrder(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, orderId, authStatus]);

  const copy = OUTCOME_COPY[outcome] ?? OUTCOME_COPY.failed;

  return (
    <section style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
      <Card>
        <h1 style={{ fontSize: 24, marginBlockEnd: 8 }}>{copy.title}</h1>
        <Alert tone={copy.tone}>{copy.body}</Alert>
        {/*
          These two are the ONLY ways forward from the payment result, and
          they were 18px tall -- measured in a real 375px viewport, well under
          the 44px baseline this project's own Button component enforces. Same
          class of finding as the 25px nav links, the 43px logout button, the
          21px homepage CTA, and the 24px search-result link before them; this
          is the surface a customer lands on straight after paying, on a
          phone.
        */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBlockStart: 8 }}>
          <Link
            href="/bookings"
            style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
          >
            رزروهای من
          </Link>
          <Link
            href="/providers"
            style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
          >
            بازگشت به فهرست متخصص‌ها
          </Link>
        </div>
      </Card>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {orderId && authStatus === 'authenticated' && !order && !error ? <LoadingState label="در حال دریافت رسید…" /> : null}

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
                  <th scope="row" style={{ textAlign: 'start', fontWeight: 400, padding: '6px 0', color: 'var(--bc-color-ink-soft)' }}>
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

              {order.refundedTotalToman > 0 ? (
                <tr>
                  <th scope="row" style={{ textAlign: 'start', padding: '6px 0', fontWeight: 400, color: 'var(--bc-color-error)' }}>
                    مبلغ بازگردانده‌شده
                  </th>
                  <td style={{ textAlign: 'end', padding: '6px 0', color: 'var(--bc-color-error)' }}>
                    {formatToman(order.refundedTotalToman)} تومان
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 13, marginBlockStart: 16 }}>
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

const ORDER_STATUS_FA: Record<string, string> = {
  pending: 'در انتظار پرداخت',
  paid: 'پرداخت‌شده',
  partially_refunded: 'بازگشت جزئی وجه',
  refunded: 'بازگشت کامل وجه',
  cancelled: 'لغو شده',
};

export default function CheckoutResultPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ResultContent />
    </Suspense>
  );
}
