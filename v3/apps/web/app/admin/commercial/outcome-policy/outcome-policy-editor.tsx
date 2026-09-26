'use client';

import { useId, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import {
  BOOKING_OUTCOME_RETENTION_KINDS,
  MAX_OUTCOME_AMOUNT_TOMAN,
  MAX_OUTCOME_GRACE_MINUTES,
  MAX_OUTCOME_HOURS,
  MAX_OUTCOME_RESCHEDULE_FREE_COUNT,
  MAX_OUTCOME_RETENTION_DAYS,
  MAX_OUTCOME_RETENTION_OPTIONS,
  MAX_OUTCOME_SET_MEMBERS,
  retentionRuleIdentity,
  type BookingOutcomeRetentionKind,
  type BookingOutcomeRetentionRule,
} from '@beauclick/commercial-policy-contract';
import { Button, Input } from '@/components/ui';
import { NumberSetEditor, ReasonField, RefusalNotice, WholeField, reasonIsValid, type EditorProps } from '@/components/commercial-lifecycle';
import { describeRetention } from '@/components/outcome-selection-groups';
import type { LegalEvidence, OutcomePolicyVersion, OutcomePolicyVersionBody } from '@/lib/commercial-admin-api';
import { RETENTION_KIND_LABEL } from '@/lib/commercial-labels';
import { ACTIVATION_END_LABEL, isoToLocalInput, localInputToIso, parseWhole } from '@/lib/commercial-lifecycle';
import styles from './outcome-policy.module.css';

/**
 * The outcome policy version editor — spec 47 §2 and §3.5–3.8.
 *
 * No defaults, anywhere: a new draft opens with every set empty, every number
 * blank and no cap. Sets are sets (the server takes ascending, duplicate-free
 * lists); retention options come in their four closed shapes, and only the
 * shape's own field exists. A legal cap is possible only against a RECORDED
 * `retention_cap` evidence record — without one the cap cannot be switched on,
 * and the editor says why rather than offering a control that would be refused.
 *
 * The activation START is not a field: the server sets it at publication.
 */

/** `validateBookingOutcomeRetentionRule`: basis points 1–9,999; an amount 1 or more. */
const BP_MAX = 9_999;

function RetentionListEditor({
  legend,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  options: BookingOutcomeRetentionRule[];
  onChange: (next: BookingOutcomeRetentionRule[]) => void;
  disabled: boolean;
}) {
  const [kind, setKind] = useState<BookingOutcomeRetentionKind | ''>('');
  const [amount, setAmount] = useState('');
  const kindId = useId();

  const rule = buildRule(kind, amount);
  const duplicate = rule !== null && options.some((o) => retentionRuleIdentity(o) === retentionRuleIdentity(rule));
  const full = options.length >= MAX_OUTCOME_RETENTION_OPTIONS;

  return (
    <fieldset className={styles.group} data-retention={legend}>
      <legend className={styles.legend}>{legend}</legend>
      {options.length === 0 ? <p className={styles.empty}>هنوز گزینه‌ای ندارد.</p> : null}
      <ul className={styles.options}>
        {options.map((option) => (
          <li key={retentionRuleIdentity(option)} className={styles.option}>
            <span>{describeRetention(option)}</span>
            <Button
              type="button"
              variant="ghost"
              inline
              aria-label={`حذف گزینهٔ «${describeRetention(option)}»`}
              onClick={() => onChange(options.filter((o) => retentionRuleIdentity(o) !== retentionRuleIdentity(option)))}
              disabled={disabled}
            >
              حذف
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.addOption}>
        <label htmlFor={kindId} className={styles.fieldLabel}>
          شکل گزینهٔ تازه
        </label>
        <select
          id={kindId}
          className={styles.select}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as BookingOutcomeRetentionKind | '');
            setAmount('');
          }}
          disabled={disabled || full}
        >
          <option value="">انتخاب کنید</option>
          {BOOKING_OUTCOME_RETENTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {RETENTION_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {kind === 'percentage_of_collected' ? (
          <WholeField label="نرخ" unit="bp، یک تا ۹٬۹۹۹" value={amount} onChange={setAmount} min={1} max={BP_MAX} disabled={disabled} />
        ) : null}
        {kind === 'fixed_toman' ? (
          <WholeField label="مبلغ" unit="تومان" value={amount} onChange={setAmount} min={1} max={MAX_OUTCOME_AMOUNT_TOMAN} disabled={disabled} />
        ) : null}
        {duplicate ? <p className={styles.fieldError}>این گزینه از پیش در فهرست هست.</p> : null}
        <Button
          type="button"
          variant="ghost"
          inline
          disabled={disabled || rule === null || duplicate || full}
          onClick={() => {
            if (!rule) return;
            onChange([...options, rule]);
            setKind('');
            setAmount('');
          }}
        >
          افزودن گزینه
        </Button>
      </div>
    </fieldset>
  );
}

function buildRule(kind: BookingOutcomeRetentionKind | '', amountText: string): BookingOutcomeRetentionRule | null {
  const n = parseWhole(amountText);
  switch (kind) {
    case 'none':
      return { kind: 'none' };
    case 'full_collected':
      return { kind: 'full_collected' };
    case 'percentage_of_collected':
      return n !== null && n >= 1 && n <= BP_MAX ? { kind: 'percentage_of_collected', basisPoints: n } : null;
    case 'fixed_toman':
      return n !== null && n >= 1 && n <= MAX_OUTCOME_AMOUNT_TOMAN ? { kind: 'fixed_toman', amountToman: n } : null;
    default:
      return null;
  }
}

const text = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

function capAmountText(cap: BookingOutcomeRetentionRule | null): string {
  if (!cap) return '';
  if (cap.kind === 'percentage_of_collected') return String(cap.basisPoints);
  if (cap.kind === 'fixed_toman') return String(cap.amountToman);
  return '';
}

export function OutcomePolicyEditor({
  initial,
  busy,
  refusal,
  onSubmit,
  onCancel,
  evidence,
}: EditorProps<OutcomePolicyVersion> & { evidence: LegalEvidence[] | null }) {
  const [cutoffs, setCutoffs] = useState<number[]>(initial?.cutoffHoursAllowed ?? []);
  const [late, setLate] = useState<BookingOutcomeRetentionRule[]>(initial?.lateRetentionOptions ?? []);
  const [grace, setGrace] = useState<number[]>(initial?.noShowGraceMinutesAllowed ?? []);
  const [noShow, setNoShow] = useState<BookingOutcomeRetentionRule[]>(initial?.noShowRetentionOptions ?? []);
  const [reschedule, setReschedule] = useState(text(initial?.rescheduleFreeCountBeforeCutoff));
  const [dispute, setDispute] = useState(text(initial?.disputeWindowHours));
  const [bodilyHarm, setBodilyHarm] = useState(text(initial?.bodilyHarmWindowHours));
  const [appeal, setAppeal] = useState(text(initial?.appealWindowHours));
  const [caseFile, setCaseFile] = useState(text(initial?.caseFileRetentionDays));
  const [capOn, setCapOn] = useState(initial?.legalCap != null);
  const [capKind, setCapKind] = useState<BookingOutcomeRetentionKind | ''>(initial?.legalCap?.kind ?? '');
  const [capAmount, setCapAmount] = useState(capAmountText(initial?.legalCap ?? null));
  const [evidenceKey, setEvidenceKey] = useState(initial?.legalEvidenceKey ?? '');
  const [endsAt, setEndsAt] = useState(isoToLocalInput(initial?.activationEndsAt ?? null));
  const [reason, setReason] = useState('');
  const capKindId = useId();
  const evidenceId = useId();

  /** Only a RECORDED record about `retention_cap` qualifies (`LEGAL_EVIDENCE_SUBJECT_FOR_CAP`). */
  const qualifying = (evidence ?? []).filter((e) => e.subject === 'retention_cap' && e.status === 'recorded');
  const canCap = qualifying.length > 0 || Boolean(initial?.legalEvidenceKey);

  const rescheduleN = parseWhole(reschedule);
  const disputeN = parseWhole(dispute);
  const bodilyN = bodilyHarm.trim() === '' ? null : parseWhole(bodilyHarm);
  const appealN = parseWhole(appeal);
  const caseFileN = caseFile.trim() === '' ? null : parseWhole(caseFile);
  const cap = capOn ? buildRule(capKind, capAmount) : null;
  const endsIso = localInputToIso(endsAt);

  const valid =
    cutoffs.length > 0 &&
    late.length > 0 &&
    grace.length > 0 &&
    noShow.length > 0 &&
    rescheduleN !== null &&
    rescheduleN <= MAX_OUTCOME_RESCHEDULE_FREE_COUNT &&
    disputeN !== null &&
    disputeN >= 1 &&
    disputeN <= MAX_OUTCOME_HOURS &&
    (bodilyHarm.trim() === '' || (bodilyN !== null && bodilyN >= 1 && bodilyN <= MAX_OUTCOME_HOURS)) &&
    appealN !== null &&
    appealN >= 1 &&
    appealN <= MAX_OUTCOME_HOURS &&
    (caseFile.trim() === '' || (caseFileN !== null && caseFileN >= 1 && caseFileN <= MAX_OUTCOME_RETENTION_DAYS)) &&
    (!capOn || (cap !== null && cap.kind !== 'none' && evidenceKey !== '')) &&
    (endsAt === '' || endsIso !== null) &&
    reasonIsValid(reason);

  function submit() {
    if (!valid || rescheduleN === null || disputeN === null || appealN === null) return;
    const body: OutcomePolicyVersionBody = {
      cutoffHoursAllowed: cutoffs,
      lateRetentionOptions: late,
      noShowGraceMinutesAllowed: grace,
      noShowRetentionOptions: noShow,
      rescheduleFreeCountBeforeCutoff: rescheduleN,
      disputeWindowHours: disputeN,
      bodilyHarmWindowHours: bodilyN,
      appealWindowHours: appealN,
      caseFileRetentionDays: caseFileN,
      legalCap: cap,
      legalEvidenceKey: capOn ? evidenceKey : null,
      activationEndsAt: endsIso,
      reason: reason.trim(),
    };
    onSubmit(body);
  }

  return (
    <form
      className={styles.editor}
      data-testid="outcome-policy-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className={styles.note}>هیچ مقداری پیشنهاد نمی‌شود: هر عدد و هر گزینه‌ای که اینجا هست را شما وارد کرده‌اید.</p>

      <NumberSetEditor
        legend="ساعت‌های مجاز برای مهلت لغو رایگان"
        unit="ساعت"
        values={cutoffs}
        onChange={setCutoffs}
        min={0}
        max={MAX_OUTCOME_HOURS}
        maxMembers={MAX_OUTCOME_SET_MEMBERS}
        disabled={busy}
      />
      <RetentionListEditor legend="گزینه‌های نگه‌داشت در لغو دیرهنگام" options={late} onChange={setLate} disabled={busy} />
      <NumberSetEditor
        legend="دقیقه‌های مجاز برای مهلت اعلام عدم‌حضور"
        unit="دقیقه"
        values={grace}
        onChange={setGrace}
        min={0}
        max={MAX_OUTCOME_GRACE_MINUTES}
        maxMembers={MAX_OUTCOME_SET_MEMBERS}
        disabled={busy}
      />
      <RetentionListEditor legend="گزینه‌های نگه‌داشت در عدم‌حضور" options={noShow} onChange={setNoShow} disabled={busy} />

      <fieldset className={styles.group}>
        <legend className={styles.legend}>مهلت‌ها و شمارش‌ها</legend>
        <div className={styles.grid}>
          <WholeField label="جابه‌جایی رایگان پیش از مهلت" unit="بار" value={reschedule} onChange={setReschedule} min={0} max={MAX_OUTCOME_RESCHEDULE_FREE_COUNT} disabled={busy} />
          <WholeField label="مهلت اعتراض" unit="ساعت" value={dispute} onChange={setDispute} min={1} max={MAX_OUTCOME_HOURS} disabled={busy} />
          <WholeField
            label="مهلت گزارش آسیب جسمی"
            unit="ساعت، اختیاری"
            hint="اگر خالی بماند، مهلتی جدا تعریف نمی‌شود. کوتاه‌تر از مهلت اعتراض پذیرفته نیست."
            value={bodilyHarm}
            onChange={setBodilyHarm}
            min={1}
            max={MAX_OUTCOME_HOURS}
            disabled={busy}
          />
          <WholeField label="مهلت درخواست بازبینی" unit="ساعت" value={appeal} onChange={setAppeal} min={1} max={MAX_OUTCOME_HOURS} disabled={busy} />
          <WholeField
            label="نگه‌داری پرونده"
            unit="روز، اختیاری"
            value={caseFile}
            onChange={setCaseFile}
            min={1}
            max={MAX_OUTCOME_RETENTION_DAYS}
            disabled={busy}
          />
        </div>
      </fieldset>

      <fieldset className={styles.group} data-testid="legal-cap">
        <legend className={styles.legend}>سقف قانونی (اختیاری)</legend>
        {canCap ? (
          <label className={styles.check}>
            <input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} disabled={busy} />
            <span>این نسخه سقف قانونی دارد</span>
          </label>
        ) : (
          <p className={styles.empty} role="note">
            سقف قانونی فقط با یک مدرک حقوقیِ ثبت‌شده دربارهٔ «سقف نگه‌داشت» منتشرشدنی است، و هنوز چنین مدرکی در فهرست مدارک نیست.
          </p>
        )}
        {capOn ? (
          <>
            <label htmlFor={capKindId} className={styles.fieldLabel}>
              شکل سقف
            </label>
            <select id={capKindId} className={styles.select} value={capKind} onChange={(e) => setCapKind(e.target.value as BookingOutcomeRetentionKind | '')} disabled={busy}>
              <option value="">انتخاب کنید</option>
              {BOOKING_OUTCOME_RETENTION_KINDS.filter((k) => k !== 'none').map((k) => (
                <option key={k} value={k}>
                  {RETENTION_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            {capKind === 'percentage_of_collected' ? (
              <WholeField label="نرخ سقف" unit="bp" value={capAmount} onChange={setCapAmount} min={1} max={BP_MAX} disabled={busy} />
            ) : null}
            {capKind === 'fixed_toman' ? (
              <WholeField label="مبلغ سقف" unit="تومان" value={capAmount} onChange={setCapAmount} min={1} max={MAX_OUTCOME_AMOUNT_TOMAN} disabled={busy} />
            ) : null}
            <label htmlFor={evidenceId} className={styles.fieldLabel}>
              مدرک حقوقی
            </label>
            <select id={evidenceId} className={styles.select} value={evidenceKey} onChange={(e) => setEvidenceKey(e.target.value)} disabled={busy}>
              <option value="">انتخاب کنید</option>
              {qualifying.map((e) => (
                <option key={e.evidenceKey} value={e.evidenceKey}>
                  {e.evidenceKey}
                </option>
              ))}
              {initial?.legalEvidenceKey && !qualifying.some((e) => e.evidenceKey === initial.legalEvidenceKey) ? (
                <option value={initial.legalEvidenceKey}>{initial.legalEvidenceKey} (در فهرست مدارکِ معتبر نیست)</option>
              ) : null}
            </select>
          </>
        ) : null}
      </fieldset>

      <Input
        label={ACTIVATION_END_LABEL}
        type="datetime-local"
        dir="ltr"
        value={endsAt}
        onChange={(e) => setEndsAt(e.target.value)}
        disabled={busy}
        hint="شروع را سرور هنگام انتشار تعیین می‌کند. اگر خالی بماند، نسخه تا انتشار نسخهٔ بعدی مؤثر می‌ماند."
      />

      <ReasonField value={reason} onChange={setReason} disabled={busy} />
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <div className={styles.actions}>
        <Button type="submit" inline disabled={!valid || busy} loading={busy}>
          {initial ? 'ذخیرهٔ پیش‌نویس' : 'ثبت پیش‌نویس'}
        </Button>
        <Button type="button" variant="ghost" inline onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </form>
  );
}

/** One line of a version's terms, for its row. */
export function OutcomePolicySummary({ version }: { version: OutcomePolicyVersion }) {
  return (
    <ul className={styles.summary}>
      <li>مهلت لغو: {version.cutoffHoursAllowed.map((h) => toPersianDigits(h)).join('، ')} ساعت</li>
      <li>لغو دیرهنگام: {version.lateRetentionOptions.map(describeRetention).join(' / ')}</li>
      <li>مهلت عدم‌حضور: {version.noShowGraceMinutesAllowed.map((m) => toPersianDigits(m)).join('، ')} دقیقه</li>
      <li>عدم‌حضور: {version.noShowRetentionOptions.map(describeRetention).join(' / ')}</li>
      <li>
        اعتراض {toPersianDigits(version.disputeWindowHours)} ساعت · بازبینی {toPersianDigits(version.appealWindowHours)} ساعت · جابه‌جایی رایگان{' '}
        {toPersianDigits(version.rescheduleFreeCountBeforeCutoff)} بار
      </li>
      {version.legalCap ? (
        <li>
          سقف قانونی: {describeRetention(version.legalCap)} · مدرک <span dir="ltr">{version.legalEvidenceKey}</span>
        </li>
      ) : null}
    </ul>
  );
}
