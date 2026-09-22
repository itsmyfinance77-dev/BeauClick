'use client';

import { useId, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import {
  BOOKING_COLLECTION_MODES,
  BOOKING_COLLECTION_PERCENTAGE_BASES,
  MAX_COLLECTION_AMOUNT_TOMAN,
  type BookingCollectionMode,
  type BookingCollectionPercentageBase,
} from '@beauclick/commercial-policy-contract';
import { Button, Input } from '@/components/ui';
import { ReasonField, RefusalNotice, WholeField, reasonIsValid, type EditorProps } from '@/components/commercial-lifecycle';
import type { CollectionDeposit, CollectionPolicyVersion, CollectionPolicyVersionBody } from '@/lib/commercial-admin-api';
import { COLLECTION_MODE_LABEL, DEPOSIT_KIND_LABEL, PERCENTAGE_BASE_LABEL } from '@/lib/commercial-labels';
import { isoToLocalInput, localInputToIso, parseWhole } from '@/lib/commercial-lifecycle';
import styles from './control-plane.module.css';

/**
 * The collection policy version editor — spec 44 §3.
 *
 * No defaults: neither a mode, nor a deposit shape, nor a percentage base is
 * chosen for the administrator, and no amount is pre-filled. A deposit rule
 * exists only in deposit mode, and deposit mode requires one — so the deposit
 * fields appear only there, and the other two modes send `{ kind: 'none' }`,
 * the one shape `validateBookingCollectionTermsV1` accepts for them.
 *
 * The activation START is absent: the database sets it at publication.
 */

const DEPOSIT_MODE: BookingCollectionMode = 'deposit_online_balance_at_venue';
/** `CollectionDepositRuleDto.basisPoints`: 1–10,000. */
const BP_MAX = 10_000;

export function CollectionPolicyEditor({ initial, busy, refusal, onSubmit, onCancel }: EditorProps<CollectionPolicyVersion>) {
  const d = initial?.deposit;
  const [mode, setMode] = useState<BookingCollectionMode | null>(initial?.collectionMode ?? null);
  const [kind, setKind] = useState<'fixed' | 'percentage' | null>(d && d.kind !== 'none' ? d.kind : null);
  const [amount, setAmount] = useState(d?.kind === 'fixed' ? String(d.amountToman) : '');
  const [bp, setBp] = useState(d?.kind === 'percentage' ? String(d.basisPoints) : '');
  const [base, setBase] = useState<BookingCollectionPercentageBase | null>(d?.kind === 'percentage' ? d.percentageBase : null);
  const [minimum, setMinimum] = useState(d?.kind === 'percentage' ? String(d.minimumToman) : '');
  const [maximum, setMaximum] = useState(d?.kind === 'percentage' && d.maximumToman !== null ? String(d.maximumToman) : '');
  const [endsAt, setEndsAt] = useState(isoToLocalInput(initial?.activationEndsAt ?? null));
  const [reason, setReason] = useState('');
  const modeName = useId();
  const kindName = useId();
  const baseName = useId();

  const deposit = buildDeposit();
  const endsIso = localInputToIso(endsAt);
  const valid = mode !== null && deposit !== null && (endsAt === '' || endsIso !== null) && reasonIsValid(reason);

  function buildDeposit(): CollectionDeposit | null {
    if (mode === null) return null;
    if (mode !== DEPOSIT_MODE) return { kind: 'none' };
    if (kind === 'fixed') {
      const n = parseWhole(amount);
      return n !== null && n >= 1 && n <= MAX_COLLECTION_AMOUNT_TOMAN ? { kind: 'fixed', amountToman: n } : null;
    }
    if (kind === 'percentage') {
      const rate = parseWhole(bp);
      const min = parseWhole(minimum);
      const max = maximum.trim() === '' ? null : parseWhole(maximum);
      if (rate === null || rate < 1 || rate > BP_MAX || base === null) return null;
      if (min === null || min > MAX_COLLECTION_AMOUNT_TOMAN) return null;
      if (maximum.trim() !== '' && (max === null || max > MAX_COLLECTION_AMOUNT_TOMAN || max < min)) return null;
      return { kind: 'percentage', basisPoints: rate, percentageBase: base, minimumToman: min, maximumToman: max };
    }
    return null;
  }

  const minN = parseWhole(minimum);
  const maxN = parseWhole(maximum);

  return (
    <form
      className={styles.editor}
      data-testid="collection-policy-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || mode === null || deposit === null) return;
        const body: CollectionPolicyVersionBody = { collectionMode: mode, deposit, activationEndsAt: endsIso, reason: reason.trim() };
        onSubmit(body);
      }}
    >
      <p className={styles.note}>هیچ گزینه‌ای از پیش انتخاب نشده و هیچ مبلغی پیشنهاد نمی‌شود.</p>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>شیوهٔ دریافت</legend>
        {BOOKING_COLLECTION_MODES.map((value) => (
          <label key={value} className={styles.radio}>
            <input type="radio" name={modeName} value={value} checked={mode === value} onChange={() => setMode(value)} disabled={busy} />
            <span>
              <strong>{COLLECTION_MODE_LABEL[value].label}</strong>
              <span className={styles.radioHint}>{COLLECTION_MODE_LABEL[value].description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === DEPOSIT_MODE ? (
        <fieldset className={styles.group} data-testid="deposit-rule">
          <legend className={styles.legend}>قاعدهٔ پیش‌پرداخت</legend>
          {(['fixed', 'percentage'] as const).map((value) => (
            <label key={value} className={styles.radio}>
              <input type="radio" name={kindName} value={value} checked={kind === value} onChange={() => setKind(value)} disabled={busy} />
              <span>{DEPOSIT_KIND_LABEL[value]}</span>
            </label>
          ))}
          {kind === 'fixed' ? (
            <WholeField label="مبلغ پیش‌پرداخت" unit="تومان" value={amount} onChange={setAmount} min={1} max={MAX_COLLECTION_AMOUNT_TOMAN} disabled={busy} />
          ) : null}
          {kind === 'percentage' ? (
            <>
              <WholeField label="نرخ" unit="bp، یک تا ۱۰٬۰۰۰" value={bp} onChange={setBp} min={1} max={BP_MAX} disabled={busy} />
              <fieldset className={styles.group} data-testid="percentage-base">
                <legend className={styles.legend}>پایهٔ درصد</legend>
                <p className={styles.note}>هیچ‌کدام پیش‌فرض نیست. تفاوتشان همان تخفیف‌ها و هزینه‌های سفارش است.</p>
                {BOOKING_COLLECTION_PERCENTAGE_BASES.map((value) => (
                  <label key={value} className={styles.radio}>
                    <input type="radio" name={baseName} value={value} checked={base === value} onChange={() => setBase(value)} disabled={busy} />
                    <span>
                      <strong>{PERCENTAGE_BASE_LABEL[value].label}</strong>
                      <span className={styles.radioHint}>{PERCENTAGE_BASE_LABEL[value].description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <WholeField label="کمینه" unit="تومان" value={minimum} onChange={setMinimum} min={0} max={MAX_COLLECTION_AMOUNT_TOMAN} disabled={busy} />
              <WholeField
                label="بیشینه"
                unit="تومان، اختیاری"
                hint="اگر خالی بماند، سقفی جز مبلغ سفارش ندارد."
                value={maximum}
                onChange={setMaximum}
                min={0}
                max={MAX_COLLECTION_AMOUNT_TOMAN}
                disabled={busy}
              />
              {minN !== null && maxN !== null && maxN < minN ? <p className={styles.fieldError}>بیشینه نمی‌تواند کمتر از کمینه باشد.</p> : null}
            </>
          ) : null}
        </fieldset>
      ) : null}

      <Input
        label="پایان فعال‌سازی (اختیاری)"
        type="datetime-local"
        dir="ltr"
        value={endsAt}
        onChange={(e) => setEndsAt(e.target.value)}
        disabled={busy}
        hint="شروع را پایگاه‌داده هنگام انتشار تعیین می‌کند و هرگز پیش از آن نیست."
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

/** A version's terms in one line. */
export function CollectionPolicySummary({ version }: { version: CollectionPolicyVersion }) {
  const d = version.deposit;
  return (
    <span className={styles.summary}>
      {COLLECTION_MODE_LABEL[version.collectionMode]?.label ?? version.collectionMode}
      {d.kind === 'fixed' ? ` · پیش‌پرداخت ${formatToman(d.amountToman)} تومان` : null}
      {d.kind === 'percentage'
        ? ` · پیش‌پرداخت ${toPersianDigits(d.basisPoints)} bp از «${PERCENTAGE_BASE_LABEL[d.percentageBase].label}»، کمینه ${formatToman(d.minimumToman)}${
            d.maximumToman !== null ? `، بیشینه ${formatToman(d.maximumToman)}` : ''
          } تومان`
        : null}
    </span>
  );
}
