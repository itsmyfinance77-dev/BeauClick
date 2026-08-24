'use client';

import Link from 'next/link';
import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Button, Card } from './ui';

/**
 * Primitives extracted while building the professional surface.
 *
 * Deliberately not a speculative component library: every export here has at
 * least two real call sites in `/pro`, and each one exists because the
 * alternative was another inline `style={{}}` block re-deciding something the
 * previous screen had already decided.
 *
 * Two of them close recurring bug CLASSES rather than instances. `TextLink`
 * carries the 44px touch baseline that `Button` has always enforced and that
 * a bare `Link` never has -- the audit records five separate instances of that
 * bug (25px nav, 43px logout, 21px homepage CTA, 24px search result, 18px
 * payment result), each fixed individually because nothing made the baseline
 * inheritable. `EmptyState` is the counterpart to the existing `ErrorState`:
 * "the server answered and you have nothing" and "the request failed" are
 * opposite messages, and five surfaces conflated them before v3.0.1.
 */

/**
 * An inline link with a real touch target.
 *
 * `display: inline-flex` + `minHeight: 44` rather than padding alone, so the
 * hit area is genuinely 44px regardless of the font size the caller uses.
 */
export function TextLink({
  href,
  children,
  tone = 'primary',
  ...rest
}: {
  href: string;
  children: ReactNode;
  tone?: 'primary' | 'muted';
} & Record<string, unknown>) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 44,
        fontWeight: 600,
        fontSize: 14,
        color: tone === 'primary' ? 'var(--bc-color-primary)' : 'var(--bc-color-ink-soft)',
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** Page title + optional subtitle + optional trailing action. One `<h1>` per page. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 'var(--bc-spacing-chip-gap)',
        marginBlockEnd: 20,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>{title}</h1>
        {subtitle ? (
          <p style={{ fontSize: 14, color: 'var(--bc-color-ink-soft)', margin: '6px 0 0' }}>{subtitle}</p>
        ) : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

/**
 * "The server answered, and the answer is that you have nothing."
 *
 * Never rendered for a failed request -- that is `ErrorState`, which offers a
 * retry because the correct user response is opposite. Keeping them as two
 * components makes conflating them a deliberate act rather than an accident.
 */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <Card>
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <p style={{ color: 'var(--bc-color-ink-soft)', fontSize: 14, margin: 0 }}>{message}</p>
        {action ? <div style={{ marginBlockStart: 16 }}>{action}</div> : null}
      </div>
    </Card>
  );
}

const BADGE_TONES = {
  neutral: { bg: 'var(--bc-color-surface-tint)', fg: 'var(--bc-color-ink-soft)' },
  success: { bg: 'var(--bc-color-success-soft)', fg: 'var(--bc-color-success)' },
  warning: { bg: 'var(--bc-color-warning-soft)', fg: 'var(--bc-color-warning)' },
  error: { bg: 'var(--bc-color-error-soft)', fg: 'var(--bc-color-error)' },
  primary: { bg: 'var(--bc-color-primary-soft)', fg: 'var(--bc-color-primary)' },
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

/**
 * A status chip. Non-interactive by design, so it deliberately does NOT carry
 * the 44px baseline -- a target that cannot be tapped for anything is not a
 * touch target, and sizing it like one would just add noise.
 */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const palette = BADGE_TONES[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 12,
        fontWeight: 700,
        padding: '3px 10px',
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string | null;
  hint?: string;
};

/** Matches `Input`'s label/hint/error wiring exactly, so the two compose in one form. */
export function Select({ label, error, hint, id, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;
  const hintId = `${selectId}-hint`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 16 }}>
      <label htmlFor={selectId} style={{ fontWeight: 600, fontSize: 14 }}>
        {label}
      </label>
      <select
        {...rest}
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        style={{
          font: 'inherit',
          padding: '12px 14px',
          borderRadius: 'var(--bc-radius-button)',
          border: `1px solid ${error ? 'var(--bc-color-error)' : 'var(--bc-color-line)'}`,
          background: 'var(--bc-color-surface)',
          color: 'var(--bc-color-ink)',
          minHeight: 44,
        }}
      >
        {children}
      </select>
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

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string | null;
  hint?: string;
};

export function Textarea({ label, error, hint, id, ...rest }: TextareaProps) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  const errorId = `${areaId}-error`;
  const hintId = `${areaId}-hint`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 16 }}>
      <label htmlFor={areaId} style={{ fontWeight: 600, fontSize: 14 }}>
        {label}
      </label>
      <textarea
        {...rest}
        id={areaId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        style={{
          font: 'inherit',
          padding: '12px 14px',
          borderRadius: 'var(--bc-radius-button)',
          border: `1px solid ${error ? 'var(--bc-color-error)' : 'var(--bc-color-line)'}`,
          background: 'var(--bc-color-surface)',
          color: 'var(--bc-color-ink)',
          minHeight: 96,
          resize: 'vertical',
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

/**
 * The first modal dialog in V3, so it establishes the focus contract rather
 * than inheriting one.
 *
 * What it guarantees, all of which had no precedent in this codebase:
 *   - focus moves INTO the dialog on open and RETURNS to the element that
 *     opened it on close (otherwise a keyboard user is dropped at the top of
 *     the document after every confirmation);
 *   - Tab and Shift+Tab cycle within the dialog and cannot reach the page
 *     behind it;
 *   - Escape closes;
 *   - `role="dialog" aria-modal="true"` with the title as its accessible name;
 *   - the backdrop click closes, but a click that STARTED inside the panel and
 *     ended on the backdrop does not -- a drag-select out of a text field is
 *     not a dismissal.
 *
 * Used only for genuinely destructive or irreversible confirmations
 * (delete a service, release a slot, complete or no-show a booking), never
 * for ordinary navigation.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pressStartedInsideRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap in both directions. Without this, Tab from the last control
      // lands on the browser chrome and then on the page behind the dialog.
      if (event.shiftKey && (active === first || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      onMouseDown={(event) => {
        pressStartedInsideRef.current = panelRef.current?.contains(event.target as Node) ?? false;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pressStartedInsideRef.current) onCancel();
        pressStartedInsideRef.current = false;
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: 'var(--bc-color-surface)',
          borderRadius: 'var(--bc-radius-card)',
          padding: 24,
          width: '100%',
          maxWidth: 420,
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h2 id={titleId} style={{ fontSize: 18, fontWeight: 800, margin: '0 0 12px' }}>
          {title}
        </h2>
        <div style={{ fontSize: 14, color: 'var(--bc-color-ink-soft)', marginBlockEnd: 20 }}>{body}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button type="button" onClick={onConfirm} loading={busy} variant={tone === 'danger' ? 'danger' : 'primary'}>
            {confirmLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            انصراف
          </Button>
        </div>
      </div>
    </div>
  );
}
