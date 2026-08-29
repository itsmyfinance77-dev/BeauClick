'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { Alert, Button, Card, Input, LoadingState } from '@/components/ui';
import { safeReturnPath } from '@/lib/safe-return';
import { toPersianDigits } from '@beauclick/persian-utils';

type Step = 'phone' | 'code';

/**
 * The OTP auth foundation: request a code, then verify it. Deliberately
 * only what this phase requires (request / verify / session creation) --
 * the full customer/professional product UI is later-phase scope.
 *
 * Every error message shown here comes from the SERVER (Persian,
 * server-translated per V3_API_CONTRACT_BLUEPRINT.md §6) -- the client
 * never invents its own copy for a server-side failure, so anti-
 * enumeration guarantees can't be undermined by a chattier frontend.
 */
function AuthContent() {
  const { requestOtp, verifyOtp, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Where to go after signing in.
   *
   * Added so a customer sent here from a page that needs a session -- the
   * checkout result's receipt, today -- comes BACK to it rather than being
   * dropped on the dashboard with no explanation of why they were interrupted.
   *
   * `safeReturnPath` is doing real work, not defensive decoration: `?next=` on
   * a login page is the most valuable place in a product to have an open
   * redirect. `/auth?next=https://evil.example/login` is a phishing page a
   * customer reaches THROUGH the real site, immediately after typing a real
   * OTP. It returns null for anything that is not an absolute path on this
   * origin, so the fallback below is the only other outcome.
   */
  const returnTo = safeReturnPath(params.get('next')) ?? '/dashboard';

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(returnTo);
  }, [status, router, returnTo]);

  async function handleRequestOtp(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestOtp(phone);
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyOtp(phone, code);
      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto' }}>
      <Card>
        <h1 style={{ fontSize: 24 }}>ورود به BeauClick</h1>

        {error ? <Alert>{error}</Alert> : null}

        {step === 'phone' ? (
          <form onSubmit={handleRequestOtp} noValidate>
            <Input
              label="شماره موبایل"
              name="phone"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="09123456789"
              hint="کد تأیید به این شماره پیامک می‌شود."
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <Button type="submit" loading={busy}>
              دریافت کد تأیید
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} noValidate>
            <p style={{ fontSize: 14, color: 'var(--bc-color-ink-soft)' }}>
              کد {toPersianDigits(6)} رقمی ارسال‌شده به {toPersianDigits(phone)} را وارد کنید.
            </p>
            <Input
              label="کد تأیید"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Button type="submit" loading={busy}>
              تأیید و ورود
            </Button>
            <div style={{ marginBlockStart: 12 }}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setError(null);
                }}
              >
                تغییر شماره موبایل
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

/**
 * `useSearchParams` suspends during prerender in the app router, so the page
 * component is a boundary around the content -- the same shape
 * `/checkout/result` uses, and for the same reason.
 */
export default function AuthPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AuthContent />
    </Suspense>
  );
}
