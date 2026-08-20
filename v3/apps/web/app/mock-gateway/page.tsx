'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { API_BASE_URL } from '@/lib/config';
import { Alert, Button, Card, LoadingState } from '@/components/ui';

/**
 * The local mock gateway's checkout page -- a stand-in for the page a real
 * Iranian gateway would host on its OWN domain.
 *
 * It is deliberately styled to look like somewhere else, and labelled
 * unmistakably as a test gateway: mistaking it for a real payment page is
 * the one confusion worth designing against.
 *
 * What it does is exactly what a real gateway does: it records a decision on
 * the gateway side, then returns the browser to our callback URL. It does
 * NOT tell us the outcome -- the callback carries only a transaction
 * reference, and the API goes and asks the gateway server-to-server. That is
 * why clicking "pay" here and then tampering with the return URL changes
 * nothing.
 */
function MockGatewayContent() {
  const params = useSearchParams();
  const reference = params.get('reference') ?? '';
  const callback = params.get('callback') ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(paid: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/mock-gateway/${encodeURIComponent(reference)}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid }),
      });
      if (!response.ok) throw new Error('درگاه آزمایشی پاسخ نداد.');

      // Return the customer to the callback the merchant supplied, carrying
      // only the transaction reference -- exactly the shape of a real
      // gateway's return leg.
      const url = new URL(callback);
      url.searchParams.set('reference', reference);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      setBusy(false);
    }
  }

  if (!reference || !callback) {
    return <Alert tone="error">پارامترهای درگاه ناقص است.</Alert>;
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
        درگاه پرداخت آزمایشی — این صفحه شبیه‌ساز است و هیچ تراکنش واقعی انجام نمی‌شود.
      </div>

      <h1 style={{ fontSize: 20, marginBlockEnd: 8 }}>پرداخت</h1>
      <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
        شناسه تراکنش:{' '}
        {/* Rendered VERBATIM, never through toPersianDigits. A gateway
            reference is an opaque machine identifier a customer may have to
            read back to support -- substituting Persian digits inside a
            mixed alphanumeric string ("MOCK-966D..." becoming
            "MOCK-۹۶۶D...") makes it materially harder to transcribe, and
            harder still to match against the gateway's own records.
            Persian digits are for QUANTITIES a human reads, not identifiers
            a human copies. */}
        <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace', unicodeBidi: 'embed' }}>
          {reference}
        </span>
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div style={{ display: 'grid', gap: 10, marginBlockStart: 20 }}>
        <Button onClick={() => void decide(true)} loading={busy}>
          پرداخت موفق
        </Button>
        <Button variant="ghost" onClick={() => void decide(false)} disabled={busy}>
          انصراف / پرداخت ناموفق
        </Button>
      </div>
    </Card>
  );
}

export default function MockGatewayPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<LoadingState />}>
      <MockGatewayContent />
    </Suspense>
  );
}
