'use client';

import { useCallback, useEffect, useState } from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { Button, ErrorState, LoadingState, Alert } from '@/components/ui';
import { PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { aiApi, aiRefusalOf, isAccessWithdrawn } from '@/lib/ai-api';
import { AssistantWorkspace } from './assistant-workspace';
import styles from './assistant.module.css';

/**
 * The customer AI assistant — `35_AI_ASSISTANT.md`, `Prototype - Customer` §17.
 *
 * What the page is, honestly: a deterministic LOCAL assistant that narrates the
 * public catalogue (`providerState: 'simulated'`), not a language model. The
 * server says so in every reply; this page never implies otherwise, and it has
 * no path to present a production model because none exists (`V32-DEC-008`).
 *
 * Consent (`V32-DEC-006`): a one-time recorded acceptance with no request body,
 * recorded under `ai_assistant_sandbox_v1` so it stays distinguishable from an
 * acceptance of approved wording. The FINAL disclosure copy is under Legal
 * review; the page shows the design's sandbox disclosure and says plainly that
 * the final text is pending — it invents no legal wording (`gate:legal` gates
 * public activation, not this screen).
 *
 * `bc_use_ai_assistant` is a customer capability. A session without it is not
 * sent a single request; the server's `CapabilityGuard` remains the control.
 */
export default function AssistantPage() {
  return (
    <ProtectedRoute>
      <Assistant />
    </ProtectedRoute>
  );
}

const CAPABILITY = 'bc_use_ai_assistant';

type Consent =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'required'; refusal: string | null }
  | { status: 'accepted' }
  | { status: 'withdrawn' };

function Assistant() {
  const { api, user } = useAuth();
  const allowed = user?.capabilities?.includes(CAPABILITY) ?? false;
  const [consent, setConsent] = useState<Consent>({ status: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const loadConsent = useCallback(async () => {
    setConsent({ status: 'loading' });
    try {
      const res = await aiApi.consent(api);
      setConsent(res.data?.accepted ? { status: 'accepted' } : { status: 'required', refusal: null });
    } catch (err) {
      if (isAccessWithdrawn(err)) setConsent({ status: 'withdrawn' });
      else setConsent({ status: 'failed', message: 'وضعیتِ رضایت خوانده نشد.' });
    }
  }, [api]);

  useEffect(() => {
    if (allowed) void loadConsent();
  }, [allowed, loadConsent]);

  async function accept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await aiApi.acceptConsent(api);
      if (res.data?.accepted) setConsent({ status: 'accepted' });
      else setAcceptError('پذیرش ثبت نشد. دوباره تلاش کنید.');
    } catch (err) {
      if (isAccessWithdrawn(err)) setConsent({ status: 'withdrawn' });
      else setAcceptError(aiRefusalOf(err)?.message ?? 'پذیرش ثبت نشد. دوباره تلاش کنید.');
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="دستیار هوشمند"
        subtitle="برای پیدا کردن متخصص و خدمت از میان اطلاعات عمومیِ ثبت‌شده در BeauClick. دستیار نه رزرو می‌کند و نه پرداخت."
      />

      {!allowed || consent.status === 'withdrawn' ? (
        <Alert tone="info">
          {allowed ? 'دسترسی شما به دستیار هوشمند دیگر فعال نیست.' : 'دستیار هوشمند برای حساب شما فعال نیست.'}
        </Alert>
      ) : consent.status === 'loading' ? (
        <LoadingState label="در حال بررسی وضعیت دستیار…" lines={3} />
      ) : consent.status === 'failed' ? (
        <ErrorState message={consent.message} onRetry={() => void loadConsent()} />
      ) : consent.status === 'required' ? (
        <ConsentCard refusal={consent.refusal} accepting={accepting} error={acceptError} onAccept={() => void accept()} />
      ) : (
        <AssistantWorkspace
          onConsentRequired={(message) => setConsent({ status: 'required', refusal: message })}
          onAccessWithdrawn={() => setConsent({ status: 'withdrawn' })}
        />
      )}
    </div>
  );
}

/**
 * The pre-consent state. Its two sentences are the design's SANDBOX disclosure
 * (§17), which the design itself marks `LEGAL REVIEW REQUIRED`; the marker is
 * shown, as the four legal pages show theirs (#240), so nobody mistakes this
 * for approved text.
 */
function ConsentCard({
  refusal,
  accepting,
  error,
  onAccept,
}: {
  refusal: string | null;
  accepting: boolean;
  error: string | null;
  onAccept: () => void;
}) {
  return (
    <section className={styles.consent} aria-labelledby="assistant-consent-title">
      <h2 id="assistant-consent-title" className={styles.sectionTitle}>
        پیش از شروع
      </h2>
      {refusal ? <Alert tone="info">{refusal}</Alert> : null}
      <p className={styles.consentText}>دستیار BeauClick می‌تواند بر اساس مسیر زیبایی و بودجهٔ ثبت‌شدهٔ شما، متخصص و خدمت پیشنهاد دهد.</p>
      <p className={styles.consentText}>این نسخهٔ آزمایشی از پاسخ‌های ازپیش‌تعریف‌شده استفاده می‌کند و به مدل هوش مصنوعی خارجی متصل نیست.</p>
      <p className={styles.legalPending} data-testid="assistant-legal-pending">
        [متنِ نهاییِ افشا و رضایت در انتظارِ بازبینیِ حقوقی است — LEGAL REVIEW REQUIRED]
      </p>
      {error ? <Alert>{error}</Alert> : null}
      <div className={styles.consentAction}>
        <Button type="button" inline loading={accepting} onClick={onAccept}>
          می‌پذیرم و شروع می‌کنم
        </Button>
      </div>
    </section>
  );
}
