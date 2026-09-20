'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { Alert, LoadingState } from '@/components/ui';
import { safeReturnPath } from '@/lib/safe-return';
import { formatIranianPhone, toPersianDigits } from '@beauclick/persian-utils';
import styles from './auth.module.css';

type Step = 'phone' | 'code';

/**
 * Sign in — `Prototype - Customer.dc.html` §08 and §11, `15_AUTH.md`.
 *
 * Phone, then a one-time code. No password anywhere, in any state.
 *
 * Every error message shown here comes from the SERVER (Persian,
 * server-translated per `V3_API_CONTRACT_BLUEPRINT.md` §6) — the client
 * never invents its own copy for a server-side failure, so the
 * anti-enumeration guarantees cannot be undermined by a chattier frontend.
 * The one exception is the phone-shape check below, which is about this
 * form's own input and never about whether an account exists.
 *
 * ## The countdown is built on the right number
 *
 * `request-otp` answers with TWO durations and they are not the same thing:
 * `cooldownRemaining` (60s) is when a RESEND would be accepted, and
 * `expiresInSeconds` (120s) is how long the code stays valid. §11 is
 * explicit that the countdown is the first one. Built on the second, it
 * would tell somebody to wait twice as long as they must.
 *
 * A 429 inside the cooldown carries `details.retryAfterSeconds` — an exact
 * number, because that limit depends only on the last request. The hourly
 * cap carries no such field, and its absence means UNKNOWN rather than
 * zero: that refusal gets the server's sentence and no countdown at all.
 *
 * ## Six boxes, not four
 *
 * The design draws four. `otp.service.ts` generates
 * `randomInt(0, 1_000_000).toString().padStart(6, '0')` — six digits. Four
 * boxes would make a real code impossible to enter, so the drawing loses
 * this one.
 *
 * The boxes are painted over ONE real input rather than being six inputs.
 * That is what keeps the code pasteable, autofillable from the SMS, and
 * usable with a screen reader; six inputs would look identical and break
 * all three.
 */

/** Digits in a code, from `otp.service.ts`. */
const CODE_LENGTH = 6;

/** What an Iranian mobile looks like, in either the national or E.164 form. */
const PHONE_SHAPE = /^(?:\+98|0)9\d{9}$/;

function secondsLabel(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return toPersianDigits(`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
}

function AuthContent() {
  const { requestOtp, verifyOtp, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Where to go after signing in.
   *
   * `safeReturnPath` is doing real work, not defensive decoration: `?next=`
   * on a login page is the most valuable place in a product to have an open
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
  const [attempted, setAttempted] = useState(false);
  /** Seconds until a resend would be accepted. Zero means it would be. */
  const [cooldown, setCooldown] = useState(0);

  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'authenticated') router.replace(returnTo);
  }, [status, router, returnTo]);

  // One interval for the whole countdown, cleared when it reaches zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const phoneLooksValid = PHONE_SHAPE.test(phone.trim());

  async function send(event?: FormEvent) {
    event?.preventDefault();
    setAttempted(true);
    if (!phoneLooksValid) return;
    setError(null);
    setBusy(true);
    try {
      const result = await requestOtp(phone.trim());
      setCooldown(result.cooldownRemaining);
      setStep('code');
      setCode('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'خطایی رخ داد.');
      /*
        An exact wait only when the server gave one. The hourly cap omits
        `retryAfterSeconds`, and that absence means "unknown" — inventing a
        countdown for it would be inventing a promise.
      */
      if (err instanceof ApiRequestError && err.status === 429) {
        const after = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (typeof after === 'number') setCooldown(after);
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyOtp(phone.trim(), code);
      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        {/* The brand mark from `public/`, decorative beside the heading. */}
        <img src="/brand/icon-circle.svg" alt="" width={30} height={30} className={styles.mark} />

        {step === 'phone' ? (
          <>
            <h1 className={`${styles.title} ${styles.titleAlone}`}>ورود به بیوکلیک</h1>

            <form onSubmit={send} noValidate className={styles.form}>
              <div>
                <label className={styles.label} htmlFor="auth-phone">
                  شماره موبایل
                </label>
                <input
                  id="auth-phone"
                  name="phone"
                  className={`${styles.phoneInput} ${attempted && !phoneLooksValid ? styles.phoneInputInvalid : ''}`}
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="09123456789"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  aria-invalid={attempted && !phoneLooksValid}
                  aria-describedby={attempted && !phoneLooksValid ? 'auth-phone-error' : undefined}
                />
              </div>

              {/*
                The one message this form writes itself, because it is about
                the shape of what was typed here and says nothing about
                whether the number belongs to an account.
              */}
              {attempted && !phoneLooksValid ? (
                <Alert tone="error">
                  <span id="auth-phone-error">شماره موبایل نامعتبر است.</span>
                </Alert>
              ) : null}

              {error ? <Alert tone="error">{error}</Alert> : null}

              <button type="submit" className={styles.submit} disabled={busy}>
                {busy ? 'در حال ارسال…' : 'ارسال کد یک‌بارمصرف'}
              </button>
            </form>

            <p className={styles.terms}>با ورود، شرایط استفاده بیوکلیک را می‌پذیرید.</p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>کد را وارد کنید</h1>
            <p className={styles.lead}>
              کد {toPersianDigits(CODE_LENGTH)}‌رقمی به{' '}
              <span className={styles.ltr}>{formatIranianPhone(phone)}</span> پیامک شد.
            </p>

            <form onSubmit={verify} noValidate className={styles.form}>
              <div className={styles.codeField} onClick={() => codeInput.current?.focus()}>
                <label className="bc-visually-hidden" htmlFor="auth-code">
                  کد یک‌بارمصرف
                </label>
                <input
                  id="auth-code"
                  ref={codeInput}
                  name="code"
                  className={styles.codeInput}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={CODE_LENGTH}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
                  aria-describedby="auth-code-hint"
                />
                <div className={styles.codeBoxes} aria-hidden="true">
                  {Array.from({ length: CODE_LENGTH }, (_, index) => (
                    <div
                      key={index}
                      className={`${styles.codeBox} ${code[index] ? styles.codeBoxFilled : ''} ${
                        index === code.length ? styles.codeBoxActive : ''
                      }`}
                      data-box={index}
                    >
                      {code[index] ? toPersianDigits(code[index]) : ''}
                    </div>
                  ))}
                </div>
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}

              <button
                type="submit"
                className={styles.submit}
                disabled={busy || code.length < CODE_LENGTH}
              >
                {busy ? 'در حال بررسی…' : 'تأیید و ورود'}
              </button>
            </form>

            {/*
              `aria-live` so the moment a resend becomes possible is
              announced rather than only repainted.
            */}
            <span id="auth-code-hint" aria-live="polite">
              {cooldown > 0 ? (
                <span className={`${styles.resend} ${styles.resendWaiting}`}>
                  ارسال دوباره کد تا {secondsLabel(cooldown)} دیگر
                </span>
              ) : (
                <button type="button" className={styles.resend} onClick={() => void send()} disabled={busy}>
                  ارسال دوباره کد
                </button>
              )}
            </span>

            <button
              type="button"
              className={styles.back}
              onClick={() => {
                setStep('phone');
                setError(null);
                setCode('');
              }}
            >
              تغییر شماره موبایل
            </button>
          </>
        )}
      </div>
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
