'use client';

import { toPersianDigits, formatToman } from '@beauclick/persian-utils';
import { retentionRuleIdentity, type AllowedOutcomeMembersV1, type BookingOutcomeRetentionRule } from '@/lib/pro-api';

/**
 * The four groups a seller chooses inside — V3.3 `#42b` / #159, ADR-051 §3,
 * design `48_SELLER_OUTCOME_POLICY.md` §3.
 *
 * ## Every group renders exactly the published members, and nothing else
 *
 * There is no numeric or free-text input here. A percentage or a Toman amount
 * that appears as a choice IS a published member, not something typed: the
 * server validates the selection against the active version's own lists and
 * refuses anything outside them, so an input would only ever produce a
 * request the server rejects.
 *
 * A group whose published list is empty renders no group at all rather than
 * an empty one, for the reason the design gives: "If a term was not
 * published, no row for it exists -- the UI never defaults one."
 *
 * ## Why retention options are keyed by `retentionRuleIdentity`
 *
 * A retention rule is a four-member discriminated union, and "one option per
 * meaning" is the contract's rule -- two `none`s, or two identical
 * percentages, are the SAME option. `retentionRuleIdentity` is the function
 * the server itself uses to say so, imported rather than reimplemented: a
 * duplicated identity rule would drift, and a drifted one would let the UI
 * offer two options the server considers one.
 */

export const REASON_MAX_LENGTH = 500;

export interface DraftSelection {
  cutoffHours: number | null;
  /** A `retentionRuleIdentity`, not the rule itself — the stable key for a radio. */
  lateCancellationRetention: string | null;
  noShowGraceMinutes: number | null;
  noShowRetention: string | null;
}

/** One retention option in the seller's own words. Never invents a figure the rule does not carry. */
export function describeRetention(rule: BookingOutcomeRetentionRule): string {
  switch (rule.kind) {
    case 'none':
      return 'هیچ مبلغی نگه داشته نمی‌شود';
    case 'full_collected':
      return 'همهٔ مبلغِ وصول‌شده نگه داشته می‌شود';
    case 'percentage_of_collected':
      return `${toPersianDigits(rule.basisPoints)} bp از مبلغِ وصول‌شده`;
    case 'fixed_toman':
      return `${formatToman(rule.amountToman)} تومان`;
  }
}

/** The chosen option's description, for the consequence preview. Empty when nothing is chosen. */
export function retentionLabel(options: readonly BookingOutcomeRetentionRule[], identity: string | null): string {
  const found = options.find((r) => retentionRuleIdentity(r) === identity);
  return found ? describeRetention(found) : '—';
}

function NumberGroup({
  legend,
  name,
  unit,
  members,
  value,
  onChange,
  disabled,
  invalid,
}: {
  legend: string;
  name: string;
  unit: string;
  members: readonly number[];
  value: number | null;
  onChange: (next: number) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <fieldset
      data-group={name}
      style={{
        border: `1px solid ${invalid ? 'var(--bc-color-error)' : 'var(--bc-color-line)'}`,
        borderRadius: 'var(--bc-radius-row)',
        padding: '12px 14px',
        marginBlockEnd: 16,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 800, padding: '0 6px' }}>{legend}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {members.map((member) => (
          <label key={member} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, minHeight: 44 }}>
            <input type="radio" name={name} checked={value === member} onChange={() => onChange(member)} disabled={disabled} />
            {toPersianDigits(member)} {unit}
          </label>
        ))}
      </div>
      {invalid ? (
        <p role="alert" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--bc-color-error)' }}>
          یکی از گزینه‌ها را انتخاب کنید.
        </p>
      ) : null}
    </fieldset>
  );
}

function RetentionGroup({
  legend,
  name,
  members,
  value,
  onChange,
  disabled,
  invalid,
}: {
  legend: string;
  name: string;
  members: readonly BookingOutcomeRetentionRule[];
  value: string | null;
  onChange: (identity: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <fieldset
      data-group={name}
      style={{
        border: `1px solid ${invalid ? 'var(--bc-color-error)' : 'var(--bc-color-line)'}`,
        borderRadius: 'var(--bc-radius-row)',
        padding: '12px 14px',
        marginBlockEnd: 16,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 800, padding: '0 6px' }}>{legend}</legend>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {members.map((member) => {
          const identity = retentionRuleIdentity(member);
          return (
            <label key={identity} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, minHeight: 44 }}>
              <input type="radio" name={name} checked={value === identity} onChange={() => onChange(identity)} disabled={disabled} />
              {describeRetention(member)}
            </label>
          );
        })}
      </div>
      {invalid ? (
        <p role="alert" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--bc-color-error)' }}>
          یکی از گزینه‌ها را انتخاب کنید.
        </p>
      ) : null}
    </fieldset>
  );
}

export function OutcomeSelectionGroups({
  allowed,
  value,
  onChange,
  disabled = false,
  showErrors = false,
}: {
  allowed: AllowedOutcomeMembersV1;
  value: DraftSelection;
  onChange: (next: DraftSelection) => void;
  disabled?: boolean;
  showErrors?: boolean;
}) {
  return (
    <div data-testid="outcome-selection-groups">
      <NumberGroup
        legend="لغو رایگان تا چند ساعت پیش از نوبت؟"
        name="cutoffHours"
        unit="ساعت"
        members={allowed.cutoffHours}
        value={value.cutoffHours}
        onChange={(next) => onChange({ ...value, cutoffHours: next })}
        disabled={disabled}
        invalid={showErrors && value.cutoffHours === null && allowed.cutoffHours.length > 0}
      />

      <RetentionGroup
        legend="اگر دیرتر از آن لغو شود، چه نگه داشته می‌شود؟"
        name="lateCancellationRetention"
        members={allowed.lateCancellationRetention}
        value={value.lateCancellationRetention}
        onChange={(next) => onChange({ ...value, lateCancellationRetention: next })}
        disabled={disabled}
        invalid={showErrors && value.lateCancellationRetention === null && allowed.lateCancellationRetention.length > 0}
      />

      <NumberGroup
        legend="چند دقیقه پس از شروع، عدم‌حضور اعلام‌شدنی است؟"
        name="noShowGraceMinutes"
        unit="دقیقه"
        members={allowed.noShowGraceMinutes}
        value={value.noShowGraceMinutes}
        onChange={(next) => onChange({ ...value, noShowGraceMinutes: next })}
        disabled={disabled}
        invalid={showErrors && value.noShowGraceMinutes === null && allowed.noShowGraceMinutes.length > 0}
      />

      <RetentionGroup
        legend="در عدم‌حضور، چه نگه داشته می‌شود؟"
        name="noShowRetention"
        members={allowed.noShowRetention}
        value={value.noShowRetention}
        onChange={(next) => onChange({ ...value, noShowRetention: next })}
        disabled={disabled}
        invalid={showErrors && value.noShowRetention === null && allowed.noShowRetention.length > 0}
      />
    </div>
  );
}
