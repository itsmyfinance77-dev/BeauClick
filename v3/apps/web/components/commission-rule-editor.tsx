'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { Button, Input } from '@/components/ui';
import { Textarea } from '@/components/kit';
import type { CommissionBase, CommissionRuleDraft, CommissionRuleKind } from '@/lib/admin-api';

/**
 * The shape-aware commission rule editor — V3.3 `#43b-1` / #173, ADR-052 §1,
 * design `50_ADMIN_COMMISSION_POLICY.md` §2–§3.
 *
 * ## "Absent, not disabled" is a correctness rule, not a styling preference
 *
 * `WriteCommissionVersionDto` states it: "left out is the only way to say
 * absent -- there is no sentinel". The service's shape check and the
 * database's own CHECK matrix both refuse any combination the four kinds do
 * not name. So a greyed-out input that still submits its value produces a
 * request the SERVER REFUSES; an input that does not exist cannot. The design
 * asks for absence because absence is the only thing that works.
 *
 * ## The four shapes, and nothing between them
 *
 *  - `zero` carries no rate, no amount, no base;
 *  - `percentage` carries a rate in basis points AND a base;
 *  - `fixed` carries an amount above zero and NO base;
 *  - `hybrid` carries an amount (which may be zero), a rate AND a base.
 *
 * ## The base is never defaulted
 *
 * The two bases differ by exactly what the customer has not paid yet, so the
 * choice changes what the platform earns. The column has no database DEFAULT
 * and the contract type has no fallback member for that reason; neither radio
 * is pre-selected here for the same one, and the order they appear in carries
 * no recommendation.
 *
 * ## Focus when the shape changes
 *
 * Switching shape REMOVES inputs. If the removed one held focus, the browser
 * drops focus to `<body>` and a keyboard user loses their place silently.
 * After every shape change focus is moved deliberately to the first field the
 * new shape owns, or to the reason box when the new shape owns none.
 */

const RULE_KINDS: readonly CommissionRuleKind[] = ['zero', 'percentage', 'fixed', 'hybrid'];

const RULE_KIND_LABEL: Record<CommissionRuleKind, string> = {
  zero: 'چیزی دریافت نمی‌شود',
  percentage: 'درصدی',
  fixed: 'مبلغ ثابت',
  hybrid: 'ترکیبی',
};

const BASES: readonly CommissionBase[] = ['platform_collected_amount', 'service_total'];

const BASE_LABEL: Record<CommissionBase, string> = {
  platform_collected_amount: 'مبلغی که سکو واقعاً وصول کرده',
  service_total: 'مبلغ کلِ خدمت',
};

/** One line each, so the difference is readable without outside knowledge. */
const BASE_HINT: Record<CommissionBase, string> = {
  platform_collected_amount: 'آنچه تا این لحظه از مشتری گرفته شده است.',
  service_total: 'بهای کامل خدمت، چه پرداخت شده باشد چه نشده.',
};

/** Which fields each shape owns. The single source the form reads. */
const SHAPE_FIELDS: Record<CommissionRuleKind, { amount: boolean; rate: boolean; base: boolean }> = {
  zero: { amount: false, rate: false, base: false },
  percentage: { amount: false, rate: true, base: true },
  fixed: { amount: true, rate: false, base: false },
  hybrid: { amount: true, rate: true, base: true },
};

export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;
export const MAX_BASIS_POINTS = 10_000;

export interface CommissionRuleEditorValue extends CommissionRuleDraft {
  reason: string;
}

/**
 * Builds the request body, omitting every field the shape does not own.
 *
 * Exported because the omission is the contract, not an implementation
 * detail: a test asserts the key is ABSENT rather than null for each shape.
 */
export function ruleBodyFor(
  kind: CommissionRuleKind,
  fields: { basisPoints: string; fixedToman: string; base: CommissionBase | null },
): CommissionRuleDraft {
  const shape = SHAPE_FIELDS[kind];
  const body: CommissionRuleDraft = { ruleKind: kind };
  if (shape.rate && fields.basisPoints !== '') body.basisPoints = Number(fields.basisPoints);
  if (shape.amount && fields.fixedToman !== '') body.fixedToman = Number(fields.fixedToman);
  if (shape.base && fields.base) body.base = fields.base;
  return body;
}

export function CommissionRuleEditor({
  busy = false,
  submitLabel,
  onSubmit,
  onCancel,
  serverError,
}: {
  busy?: boolean;
  submitLabel: string;
  onSubmit: (value: CommissionRuleEditorValue) => void;
  onCancel: () => void;
  /**
   * The server's refusal, rendered without clearing anything. A conflict means
   * somebody else moved first; making an administrator retype a paragraph of
   * justification is the wrong penalty for that.
   */
  serverError?: string | null;
}) {
  const [kind, setKind] = useState<CommissionRuleKind>('zero');
  const [basisPoints, setBasisPoints] = useState('');
  const [fixedToman, setFixedToman] = useState('');
  // `null`, not a first member: neither base is chosen for the administrator.
  const [base, setBase] = useState<CommissionBase | null>(null);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);

  const rateId = useId();
  const amountId = useId();
  const reasonId = useId();
  const errorId = useId();

  const rateRef = useRef<HTMLInputElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  // Skips the focus move on first render: the editor opening should not yank
  // focus out of whatever the administrator was reading.
  const mountedRef = useRef(false);

  const shape = SHAPE_FIELDS[kind];

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    // The field the new shape owns first, or the reason box when it owns none.
    const target = shape.amount ? amountRef.current : shape.rate ? rateRef.current : reasonRef.current;
    target?.focus();
  }, [kind, shape.amount, shape.rate]);

  const reasonTooShort = reason.trim().length < REASON_MIN_LENGTH;
  const baseMissing = shape.base && base === null;
  const rateMissing = shape.rate && basisPoints.trim() === '';
  const amountMissing = shape.amount && fixedToman.trim() === '';
  const incomplete = reasonTooShort || baseMissing || rateMissing || amountMissing;

  function submit() {
    setAttempted(true);
    if (incomplete) {
      // Stopped here rather than at the server: the bounds are known, and a
      // round trip to be told so is a worse experience than saying it now.
      (reasonTooShort ? reasonRef.current : shape.amount ? amountRef.current : rateRef.current)?.focus();
      return;
    }
    onSubmit({ ...ruleBodyFor(kind, { basisPoints, fixedToman, base }), reason: reason.trim() });
  }

  return (
    <div data-testid="commission-rule-editor" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <fieldset style={{ border: '1px solid var(--bc-color-line)', borderRadius: 'var(--bc-radius-row)', padding: '12px 14px' }}>
        <legend style={{ fontSize: 13, fontWeight: 800, padding: '0 6px' }}>شکلِ قاعده</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {RULE_KINDS.map((option) => (
            <label key={option} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, minHeight: 44 }}>
              <input
                type="radio"
                name="commission-rule-kind"
                value={option}
                checked={kind === option}
                onChange={() => setKind(option)}
                disabled={busy}
              />
              {RULE_KIND_LABEL[option]}
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        Rendered only when the shape owns them. Not disabled, not greyed, not
        hidden by CSS -- absent, because that is the only state the server
        accepts. See the file header.
      */}
      {shape.amount ? (
        <Input
          id={amountId}
          ref={amountRef}
          type="number"
          min={0}
          inputMode="numeric"
          label="مبلغ ثابت (تومان)"
          hint={kind === 'hybrid' ? 'در شکل ترکیبی می‌تواند صفر باشد.' : 'باید بزرگ‌تر از صفر باشد.'}
          error={attempted && amountMissing ? 'مبلغ ثابت را وارد کنید.' : undefined}
          value={fixedToman}
          onChange={(e) => setFixedToman(e.target.value)}
          disabled={busy}
        />
      ) : null}

      {shape.rate ? (
        <Input
          id={rateId}
          ref={rateRef}
          type="number"
          min={0}
          max={MAX_BASIS_POINTS}
          inputMode="numeric"
          label="نرخ (بر حسب bp)"
          hint={`هر ۱۰۰ bp برابر یک درصد است. بیشینه ${toPersianDigits(MAX_BASIS_POINTS)} bp.`}
          error={attempted && rateMissing ? 'نرخ را وارد کنید.' : undefined}
          value={basisPoints}
          onChange={(e) => setBasisPoints(e.target.value)}
          disabled={busy}
        />
      ) : null}

      {shape.base ? (
        <fieldset
          style={{
            border: attempted && baseMissing ? '1px solid var(--bc-color-error)' : '1px solid var(--bc-color-line)',
            borderRadius: 'var(--bc-radius-row)',
            padding: '12px 14px',
          }}
        >
          <legend style={{ fontSize: 13, fontWeight: 800, padding: '0 6px' }}>نرخ بر چه مبنایی؟</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {BASES.map((option) => (
              <label key={option} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, minHeight: 44 }}>
                <input
                  type="radio"
                  name="commission-base"
                  value={option}
                  checked={base === option}
                  onChange={() => setBase(option)}
                  disabled={busy}
                  style={{ marginBlockStart: 4 }}
                />
                <span>
                  <span style={{ fontWeight: 700 }}>{BASE_LABEL[option]}</span>
                  <br />
                  <span style={{ fontSize: 12.5, color: 'var(--bc-color-ink-soft)' }}>{BASE_HINT[option]}</span>
                </span>
              </label>
            ))}
          </div>
          {attempted && baseMissing ? (
            <p role="alert" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--bc-color-error)' }}>
              یکی از دو مبنا را انتخاب کنید. هیچ‌کدام پیش‌فرض نیست.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <Textarea
        id={reasonId}
        ref={reasonRef}
        label="دلیل این تغییر"
        rows={2}
        maxLength={REASON_MAX_LENGTH}
        hint={`الزامی. حداکثر ${toPersianDigits(REASON_MAX_LENGTH)} نویسه. در گزارش عملیات ثبت می‌شود.`}
        error={attempted && reasonTooShort ? 'دلیل را بنویسید.' : undefined}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />

      {serverError ? (
        <p id={errorId} role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.85, color: 'var(--bc-color-error)' }}>
          {serverError}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Button onClick={submit} loading={busy}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </div>
  );
}
