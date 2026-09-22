'use client';

import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';
import skeletonStyles from './skeleton.module.css';
import styles from './ui.module.css';

/**
 * Minimal shared UI primitives for the Phase 1 foundation -- deliberately
 * the smallest set the auth foundation actually needs (Button, Input,
 * Alert, Spinner, Card), not a port of V2's full design-system library.
 * Every value comes from a design token; no hardcoded colors/radii.
 * V2's richer primitive set is DIRECT REUSE material for a later phase
 * once real product screens exist to justify each component.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * `danger` is a ghost button in the error colour, added for the professional
   * surface's destructive confirmations (release a slot, delete a service,
   * mark a no-show). It is a real variant rather than a caller-supplied
   * `style` override so that "this action is destructive" stays a design-system
   * decision with one implementation, not a colour each screen picks.
   */
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  /**
   * Marks the control `aria-busy` WITHOUT swapping its label to the generic
   * "در حال انجام…" or forcing it disabled on its own -- for a caller whose
   * own text already says what is in progress (V3.3 Story #149's "در حالِ
   * اعطا…") and who disables the control itself via `disabled`. A plain
   * `aria-busy` passed through `...rest` would be silently overwritten by the
   * `loading`-derived one below; this is the real prop for that case.
   */
  busy?: boolean;
  /** Sizing hook for rows where a full-width button would be absurd. Never below 44px. */
  inline?: boolean;
};

const BUTTON_VARIANT_CLASS = {
  primary: 'buttonPrimary',
  ghost: 'buttonGhost',
  danger: 'buttonDanger',
} as const;

export function Button({ variant = 'primary', loading = false, busy = false, inline = false, disabled, children, ...rest }: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || busy || undefined}
      className={`${styles.button} ${styles[BUTTON_VARIANT_CLASS[variant]]} ${inline ? styles.buttonInline : ''}`}
    >
      {loading ? 'در حال انجام…' : children}
    </button>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: string;
};

/**
 * `forwardRef` so a caller can move focus to the field — V3.3 `#43b-1` / #173.
 *
 * Additive: every existing caller passes no ref and renders identically. The
 * commission rule editor needs it because changing a rule's shape REMOVES
 * inputs, and a removed input that held focus drops focus to `<body>`, which
 * loses a keyboard user's place silently.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, error, hint, id, ...rest }, ref) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  // Phone/OTP entry is digits: keep them LTR-ordered inside an RTL document
  // so "0912..." doesn't visually reverse.
  const isNumeric = rest.inputMode === 'numeric';

  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.fieldLabel}>
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        // Ties the message to the field for screen readers -- an error a
        // sighted user sees must also be announced.
        aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        className={`${styles.input} ${error ? styles.fieldError : ''} ${isNumeric ? styles.inputNumeric : ''}`}
      />
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" className={styles.fieldErrorMessage}>
          {error}
        </span>
      ) : null}
    </div>
  );
});

/**
 * `warning` was added for the payment result page's `unresolved` state
 * (V3.1 Phase F): a verification the gateway never answered is neither a
 * success nor a failure, and rendering it in the error colour would tell a
 * customer their payment failed when nobody knows whether it did.
 *
 * It uses the EXISTING measured `warning` / `warning-soft` token pair rather
 * than a new colour -- that pair is already asserted against WCAG AA in
 * `packages/design-tokens/src/contrast.spec.ts`, so this variant inherits a
 * recorded ratio instead of introducing an unmeasured one.
 */
/**
 * Four tones, not three — `V3_DESIGN_SYSTEM.md` §2.
 *
 * `info` was missing, and its absence was not cosmetic: the verification
 * notice was rendered with `success` and the search-limit notice with
 * `error`, so the colour told the reader "this went well" and "something
 * failed" about two messages that mean neither. A colour that carries the
 * wrong meaning is worse than no colour.
 */
type AlertTone = 'error' | 'success' | 'warning' | 'info';

const ALERT_TONE_CLASS: Record<AlertTone, string> = {
  error: 'alertError',
  success: 'alertSuccess',
  warning: 'alertWarning',
  info: 'alertInfo',
};

/**
 * Only a failure interrupts.
 *
 * `role="alert"` is assertive: a screen reader cuts off whatever it is
 * reading to announce it. That is right for a refusal and wrong for a
 * confirmation or a note, which should be announced when the reader reaches
 * a natural break. Every tone stays a live region; the two that are not
 * failures are polite ones.
 */
const ALERT_TONE_ROLE: Record<AlertTone, 'alert' | 'status'> = {
  error: 'alert',
  warning: 'alert',
  success: 'status',
  info: 'status',
};

export function Alert({ tone = 'error', children }: { tone?: AlertTone; children: ReactNode }) {
  return (
    <div
      role={ALERT_TONE_ROLE[tone]}
      /* A structural hook, because the ROLE is no longer a stable locator:
         it now varies by tone, and that variation is the thing under test. */
      data-bc-alert={tone}
      className={`${styles.alert} ${styles[ALERT_TONE_CLASS[tone]]}`}
    >
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}

/**
 * The state a page is in when its data never arrived: the request failed and
 * there is nothing to show.
 *
 * This is deliberately NOT the same thing as an empty state, and the
 * distinction is the whole point of the component. An empty state asserts
 * something -- "the server answered, and the answer is that you have
 * nothing" -- and several V3 pages were making that assertion after a
 * request that never completed, because a failed fetch leaves the same
 * empty array an genuinely-empty response does. "هنوز اعلانی ندارید" and
 * "we could not reach the server" call for opposite responses from the
 * user, so they must never be shown together or mistaken for each other.
 *
 * The retry closes the other half of the problem: every one of those pages
 * previously left the user on a dead end whose only escape was a manual
 * browser reload.
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card>
      <Alert>{message}</Alert>
      {onRetry ? (
        <Button type="button" variant="ghost" onClick={onRetry}>
          تلاش دوباره
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * One placeholder shape. `width` and `height` take any CSS length; a caller
 * that knows what is loading (an avatar, a card, a price) draws that shape,
 * and `LoadingState` below is the generic stack for a caller that does not.
 * Decorative: `aria-hidden`, because the status message is the announcement.
 */
export function Skeleton({ width, height }: { width?: string | number; height?: string | number }) {
  const px = (v: string | number | undefined) => (typeof v === 'number' ? `${v}px` : v);
  return (
    <span
      className={skeletonStyles.bar}
      aria-hidden='true'
      style={{ '--sk-w': px(width), '--sk-h': px(height) } as CSSProperties}
    />
  );
}

/**
 * Loading state primitive -- a skeleton on screen and a polite status message
 * for assistive tech. The label is still in the DOM (visually hidden), so the
 * announcement and every test that looks for it are unchanged.
 */
export function LoadingState({ label = 'در حال بارگذاری…', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div role='status' aria-live='polite' className={skeletonStyles.stack}>
      <span className={skeletonStyles.label}>{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        // The last line is shorter, the way a paragraph ends.
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
