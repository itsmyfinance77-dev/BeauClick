'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { API_BASE_URL } from '@/lib/config';
import { isAllowedCallback } from '@/lib/sandbox-callback';
import { Alert, Button, Card, LoadingState } from '@/components/ui';

type Decision = 'success' | 'failure' | 'cancel';

/**
 * The sandbox gateway's checkout page -- a stand-in for the page a real
 * Iranian gateway would host on its OWN domain.
 *
 * It is deliberately labelled unmistakably as a test gateway: mistaking it
 * for a real payment page is the one confusion worth designing against.
 *
 * What it does is exactly what a real gateway does: it records a decision on
 * the gateway side, then returns the browser to our callback URL. It does
 * NOT tell us the outcome -- the callback carries only a transaction
 * reference, and the API goes and asks the gateway server-to-server. That is
 * why choosing "پرداخت موفق" here and then tampering with the return URL
 * changes nothing.
 *
 * The three decisions are explicit and separate because FAILURE (the bank
 * refused) and CANCEL (the customer walked away) are genuinely different
 * events that produce different failure codes downstream, and a QA engineer
 * reproducing a support ticket has to be able to pick the right one.
 */
function SandboxGatewayContent() {
  const params = useSearchParams();
  const reference = params.get('reference') ?? '';
  const callback = params.get('callback') ?? '';
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision) {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/sandbox-gateway/${encodeURIComponent(reference)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) throw new Error('درگاه آزمایشی پاسخ نداد.');

      // The decide endpoint answers 200 with `{ accepted: false }` for every
      // refusal it knows about -- the sandbox being disabled, an
      // unrecognised decision, and (the one that shows up in ordinary QA) a
      // transaction that was already decided, because `decide()` is a
      // compare-and-swap on `outcome = 'pending'`.
      //
      // `response.ok` is TRUE in all of those cases, so checking only the
      // HTTP status meant a refused decision was followed by a confident
      // redirect to the "payment done" leg. Double-clicking a button was
      // enough to reach it.
      // `decide` is an ordinary JSON route, so its answer arrives inside the
      // standard `{ data, meta, error }` envelope -- the two callback routes
      // beside it carry `@SkipResponseEnvelope()` precisely because they are
      // redirects and this one is not. `R31-20`: this used to read
      // `body.accepted` off the ENVELOPE, where it is always `undefined`, so
      // the guard below fired on every response including a successful one.
      // A customer who paid saw "این تراکنش پیش‌تر نهایی شده است" and was
      // never returned to the callback, leaving the order pending forever --
      // the same browser-only shape as R31-17, a different root cause.
      const envelope = (await response.json().catch(() => null)) as {
        data?: { accepted?: boolean; reason?: string } | null;
      } | null;
      const body = envelope?.data ?? null;
      if (!body?.accepted) {
        throw new Error(
          body?.reason === 'sandbox_gateway_disabled'
            ? 'درگاه آزمایشی در این محیط غیرفعال است.'
            : 'این تراکنش پیش‌تر نهایی شده است و دوباره قابل تغییر نیست.',
        );
      }

      // Return the customer to the callback the merchant supplied, carrying
      // only the transaction reference -- exactly the shape of a real
      // gateway's return leg. Note what is NOT sent: the outcome. The API
      // must go and ask the gateway itself.
      const url = new URL(callback);
      url.searchParams.set('reference', reference);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      setBusy(null);
    }
  }

  if (!reference || !callback) {
    return <Alert tone="error">پارامترهای درگاه ناقص است.</Alert>;
  }

  // `callback` is an ordinary query parameter, so it is entirely
  // attacker-chosen. Navigating to it unchecked makes this page an open
  // redirect: /sandbox-gateway?reference=x&callback=https://evil.example
  // renders a plausible BeauClick payment screen that lands the visitor on
  // someone else's site. The frontend route has no server-side gate of its
  // own -- the sandbox PROVIDER is disabled in production, but this PAGE
  // still renders -- so it must not rely on the API's gate to be safe.
  //
  // The legitimate value is always the API's own payment callback
  // (`${PUBLIC_API_BASE_URL}/v1/payments/callback/<provider>`, built server
  // side in SandboxPaymentProvider.initiate), so requiring the same origin
  // as the configured API is exact rather than approximate.
  if (!isAllowedCallback(callback, window.location.origin)) {
    return <Alert tone="error">آدرس بازگشت درگاه معتبر نیست.</Alert>;
  }

  return (
    <Card>
      <div
        style={{
          background: 'var(--bc-color-warning-soft)',
          color: 'var(--bc-color-warning)',
          padding: '10px 14px',
          borderRadius: 'var(--bc-radius-row)',
          fontSize: 13,
          fontWeight: 700,
          marginBlockEnd: 20,
        }}
      >
        درگاه پرداخت آزمایشی (Sandbox) — این صفحه شبیه‌ساز است و هیچ تراکنش واقعی انجام نمی‌شود.
      </div>

      <h1 style={{ fontSize: 20, marginBlockEnd: 8 }}>پرداخت آزمایشی</h1>
      <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
        شناسه تراکنش:{' '}
        {/* Rendered VERBATIM, never through toPersianDigits. A gateway
            reference is an opaque machine identifier a customer may have to
            read back to support -- substituting Persian digits inside a
            mixed alphanumeric string ("SBX-966D..." becoming "SBX-۹۶۶D...")
            makes it materially harder to transcribe, and harder still to
            match against the gateway's own records. Persian digits are for
            QUANTITIES a human reads, not identifiers a human copies. */}
        <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace', unicodeBidi: 'embed' }}>
          {reference}
        </span>
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div style={{ display: 'grid', gap: 10, marginBlockStart: 20 }}>
        <Button onClick={() => void decide('success')} loading={busy === 'success'} disabled={busy !== null}>
          پرداخت موفق
        </Button>
        <Button variant="ghost" onClick={() => void decide('failure')} disabled={busy !== null}>
          پرداخت ناموفق (رد شده توسط بانک)
        </Button>
        <Button variant="ghost" onClick={() => void decide('cancel')} disabled={busy !== null}>
          انصراف از پرداخت
        </Button>
      </div>
    </Card>
  );
}

export default function SandboxGatewayPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<LoadingState />}>
      <SandboxGatewayContent />
    </Suspense>
  );
}
