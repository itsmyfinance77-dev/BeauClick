'use client';

import Link from 'next/link';
import type {
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TdHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useEffect, useId, useRef } from 'react';
import { Button, Card } from './ui';
import tableStyles from './data-table.module.css';
import formStyles from './form-grid.module.css';
import progressStyles from './progress-bar.module.css';

/**
 * The shared component kit.
 *
 * Started life as `pro-ui.tsx`, extracted while building the professional
 * surface. Phase A then built eight admin screens on it and Phase G added the
 * primitives below, at which point nine of its twenty-one importers were under
 * `/admin` and the name was simply wrong -- hence `kit`. Nothing about the
 * rule changed with the name.
 *
 * Deliberately not a speculative component library: every export here has at
 * least two real call sites, and each one exists because the alternative was
 * another inline `style={{}}` block re-deciding something a previous screen had
 * already decided.
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

/** `forwardRef` for the same reason `Input` carries one — V3.3 `#43b-1` / #173. Additive. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, error, hint, id, ...rest }, ref) {
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
        ref={ref}
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
});

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
  describedById,
  confirmDisabled = false,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Id of an element already rendered inside `body` -- wires `aria-describedby`
   * on the dialog panel. Optional and additive: every existing caller renders
   * exactly as before, and a caller with a genuine consequence description
   * (V3.3 Story #149, the finance-access revoke dialog) can now tie it to the
   * dialog rather than leaving it as unlinked prose.
   */
  describedById?: string;
  /**
   * Disables the confirm button independently of `busy` -- for a dialog that
   * requires an explicit acknowledgement (a checkbox) before its destructive
   * action may fire, without inventing a second dialog component for it.
   */
  confirmDisabled?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pressStartedInsideRef = useRef(false);
  const titleId = useId();
  // Read inside the key handler without re-running the open effect (and
  // re-stealing focus) every time a mutation starts or ends.
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
        // While a mutation is in flight the dialog must stay open and its
        // controls disabled (V3.3 Story #149) -- otherwise Escape would
        // abandon the dialog mid-request with no way to observe the outcome.
        if (busyRef.current) return;
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
        aria-describedby={describedById}
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
          <Button
            type="button"
            onClick={onConfirm}
            loading={busy}
            disabled={confirmDisabled}
            variant={tone === 'danger' ? 'danger' : 'primary'}
          >
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

/* ------------------------------------------------------------------ *
 * Phase G additions.
 *
 * Same rule as everything above: extracted from real duplication, never
 * anticipated. Each one replaced two or more hand-written implementations that
 * had already drifted from each other, and the drift is named in each docblock
 * so a reader can check the claim rather than take it on faith.
 * ------------------------------------------------------------------ */

/**
 * A row of mutually exclusive options, as buttons.
 *
 * Extracted when the analytics reporting window and the availability horizon
 * both needed one and the second would otherwise have copied the first. It is
 * NOT a tablist: `role="tablist"` promises arrow-key traversal between tabs and
 * an associated tabpanel, and claiming a role whose keyboard contract is not
 * implemented is worse for a screen-reader user than claiming no role at all.
 * A labelled `group` of `aria-pressed` toggle buttons is what this actually is,
 * and Tab-then-Enter is exactly how it behaves.
 *
 * `/pro/bookings` keeps its own real tablist. That one genuinely switches
 * between two panels of content and is a different component with a different
 * contract; merging them would mean one of the two lying about itself.
 */
export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  /** Accessible name for the group. Never omitted -- an unlabelled group of buttons is a puzzle. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'flex', gap: 'var(--bc-spacing-chip-gap)', flexWrap: 'wrap' }}
    >
      {options.map((option) => {
        const isCurrent = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={isCurrent}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              font: 'inherit',
              fontSize: 13,
              // Weight as well as colour, so the selection survives a reader
              // who cannot make the colour distinction.
              fontWeight: isCurrent ? 800 : 600,
              minHeight: 44,
              padding: '0 14px',
              borderRadius: 999,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              border: `1px solid ${isCurrent ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
              background: isCurrent ? 'var(--bc-color-primary-soft)' : 'transparent',
              color: isCurrent ? 'var(--bc-color-primary)' : 'var(--bc-color-ink)',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A responsive row of figures.
 *
 * Eight hand-written `repeat(auto-fit, minmax(N, 1fr))` grids existed across
 * `/pro` and `/admin` with N ranging over 150, 160, 170, 180 and 190 for no
 * reason anyone recorded -- the spacing decision was re-made on each screen
 * because nothing carried it. `min` stays a prop because a row of four short
 * counters and a row of three long currency figures genuinely want different
 * break points, but it now has one default most callers can take.
 */
export function StatGrid({ min = 180, children }: { min?: number; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--bc-spacing-card-gap)',
        gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * One figure with its label.
 *
 * The value font size was 20, 22 or 24 depending on which screen you were on;
 * it is one size here. `overflowWrap` matters more than it looks: a formatted
 * Toman figure is a long unbroken run of Persian digits and separators, and at
 * 375px inside a 180px grid track the previous inline versions could push their
 * own card wider than its column.
 */
export function StatCard({
  label,
  value,
  footer,
}: {
  label: ReactNode;
  value: ReactNode;
  /** Optional trailing row -- a `Badge`, a `TextLink` into the detail screen. */
  footer?: ReactNode;
}) {
  return (
    <Card>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>{label}</p>
      <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800, overflowWrap: 'anywhere' }}>{value}</p>
      {footer ? (
        <div style={{ marginBlockStart: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A table on wide screens, a card list on narrow ones — the pattern
 * `V3.3_RESPONSIVE_AND_A11Y_HANDOFF.md` §3 gives for "wide tables". The
 * layout lives in `data-table.module.css`; this component is the markup
 * contract it depends on.
 *
 * - `head` is the column labels. Each `DataCell` repeats its own label in
 *   `data-label`, which the card layout shows above the value, so the two
 *   lists must agree — a cell without a label is a card row without a name.
 * - The wrapper is a focusable named region, so a keyboard user can scroll the
 *   table at tablet widths where it keeps its columns and scrolls sideways.
 * - Every element also carries its ARIA role. Below 640px the table elements
 *   are `display: block`, and some screen readers stop treating a block-display
 *   table as a table; the explicit roles keep the tree a table at every width.
 */
export function DataTable({
  head,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  children,
}: {
  head: readonly string[];
  'aria-labelledby': string;
  'aria-describedby'?: string;
  children: ReactNode;
}) {
  return (
    <div className={tableStyles.scroller} role="region" aria-labelledby={labelledBy} tabIndex={0}>
      <table className={tableStyles.table} role="table" aria-labelledby={labelledBy} aria-describedby={describedBy}>
        <thead role="rowgroup">
          <tr role="row">
            {head.map((label) => (
              <th key={label} role="columnheader" scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">{children}</tbody>
      </table>
    </div>
  );
}

export function DataRow({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr role="row" {...rest}>
      {children}
    </tr>
  );
}

export function DataCell({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td role="cell" data-label={label} {...rest}>
      {children}
    </td>
  );
}

/**
 * Two columns while each stays at least 240px wide, one below — for a form whose fields are genuinely
 * pairs (from/to, start/end). A pair breaks together by construction: see
 * `form-grid.module.css`. Wrap anything that is not half of a pair in
 * `FormFullRow`.
 */
export function FormGrid({ children }: { children: ReactNode }) {
  return (
    <div className={formStyles.container}>
      <div className={formStyles.grid}>{children}</div>
    </div>
  );
}

export function FormFullRow({ children }: { children: ReactNode }) {
  return <div className={formStyles.fullRow}>{children}</div>;
}

/**
 * A determinate progress bar with the semantics a screen reader needs:
 * `role="progressbar"` with `aria-valuenow/min/max` and a name.
 *
 * `value` is a percentage. It is clamped to 0–100 and rounded for
 * `aria-valuenow`, because the server's `percentToNextTier` is a float and an
 * announcement of "42.857142 percent" is noise. Extracted from two hand-written
 * copies (`/loyalty` and the dashboard's loyalty card) — `V3_COMPONENT_INVENTORY.md`,
 * `ProgressBar`: "استخراج".
 */
export function ProgressBar({
  value,
  label,
  tone = 'light',
}: {
  value: number;
  /** The accessible name, e.g. «پیشرفت تا سطح طلایی». Never omitted. */
  label: string;
  /** `onDark` for use inside a dark card. */
  tone?: 'light' | 'onDark';
}) {
  const pct = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`${progressStyles.track} ${tone === 'onDark' ? progressStyles.onDark : ''}`}
    >
      <div className={progressStyles.fill} style={{ '--pb': `${pct}%` } as CSSProperties} />
    </div>
  );
}
