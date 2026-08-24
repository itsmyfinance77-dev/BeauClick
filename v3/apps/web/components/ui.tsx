'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

/**
 * Minimal shared UI primitives for the Phase 1 foundation -- deliberately
 * the smallest set the auth foundation actually needs (Button, Input,
 * Alert, Spinner, Card), not a port of V2's full design-system library.
 * Every value comes from a design token; no hardcoded colors/radii.
 * V2's richer primitive set is DIRECT REUSE material for a later phase
 * once real product screens exist to justify each component.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost';
  loading?: boolean;
};

export function Button({ variant = 'primary', loading = false, disabled, children, ...rest }: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={{
        font: 'inherit',
        fontWeight: 600,
        padding: '12px 20px',
        borderRadius: 'var(--bc-radius-button)',
        border: variant === 'primary' ? 'none' : '1px solid var(--bc-color-line)',
        background: variant === 'primary' ? 'var(--bc-color-primary)' : 'transparent',
        color: variant === 'primary' ? 'var(--bc-color-surface)' : 'var(--bc-color-ink)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.6 : 1,
        width: '100%',
        minHeight: 44, // accessibility: comfortable touch target on mobile
      }}
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

export function Input({ label, error, hint, id, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 16 }}>
      <label htmlFor={inputId} style={{ fontWeight: 600, fontSize: 14 }}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        // Ties the message to the field for screen readers -- an error a
        // sighted user sees must also be announced.
        aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        style={{
          font: 'inherit',
          padding: '12px 14px',
          borderRadius: 'var(--bc-radius-button)',
          border: `1px solid ${error ? 'var(--bc-color-error)' : 'var(--bc-color-line)'}`,
          background: 'var(--bc-color-surface)',
          color: 'var(--bc-color-ink)',
          minHeight: 44,
          // Phone/OTP entry is digits: keep them LTR-ordered inside an RTL
          // document so "0912..." doesn't visually reverse.
          direction: rest.inputMode === 'numeric' ? 'ltr' : undefined,
          textAlign: rest.inputMode === 'numeric' ? 'center' : undefined,
        }}
      />
      {hint ? (
        <span id={hintId} style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ fontSize: 12, color: 'var(--bc-color-error)' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success'; children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--bc-radius-row)',
        marginBlockEnd: 16,
        fontSize: 14,
        background: tone === 'error' ? 'var(--bc-color-error-soft)' : 'var(--bc-color-success-soft)',
        color: tone === 'error' ? 'var(--bc-color-error)' : 'var(--bc-color-success)',
      }}
    >
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bc-color-surface)',
        border: '1px solid var(--bc-color-line)',
        borderRadius: 'var(--bc-radius-card)',
        padding: 24,
      }}
    >
      {children}
    </div>
  );
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

/** Loading state primitive -- announced to assistive tech rather than a silent spinner. */
export function LoadingState({ label = 'در حال بارگذاری…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" style={{ color: 'var(--bc-color-ink-soft)', textAlign: 'center', padding: 24 }}>
      {label}
    </p>
  );
}
