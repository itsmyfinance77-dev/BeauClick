'use client';

import { useId, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import {
  CAPABILITY_KEY_PATTERN,
  COMMERCIAL_CURRENCY,
  MAX_CATALOGUE_QUANTITY,
  MAX_UNIT_PRICE_TOMAN,
  validatePriceScheduleTermsV1,
} from '@beauclick/commercial-policy-contract';
import { Button, Input } from '@/components/ui';
import { Select } from '@/components/kit';
import { NumberSetEditor, ReasonField, RefusalNotice, WholeField, reasonIsValid, type EditorProps } from '@/components/commercial-lifecycle';
import type {
  PlanVersion,
  PlanVersionBody,
  PriceScheduleVersionBody,
  PriceScheduleVersionDetail,
  PriceTier,
} from '@/lib/commercial-admin-api';
import { lifecycleView } from '@/lib/commercial-labels';
import { isoToLocalInput, localInputToIso, parseWhole } from '@/lib/commercial-lifecycle';
import styles from './plans.module.css';

/**
 * The catalogue editors — spec 40 §2.
 *
 * Integer IRT only: every number is `type="number" step="1"` text that is
 * parsed without rounding, and Toman figures are echoed in Persian digits over
 * the unchanged integer. Nothing is pre-filled — not a tier, not a price, not
 * a quantity. Unlike the policy families, plan and schedule versions take an
 * administrator-set activation START (`ActivationWindowDto`), so it is a field
 * here, and a required one.
 */

// ============================================================ price schedule

interface TierRow {
  id: number;
  min: string;
  max: string;
  price: string;
}

let nextTierId = 1;
const toRow = (tier: PriceTier): TierRow => ({
  id: nextTierId++,
  min: String(tier.minQuantity),
  max: tier.maxQuantity === null ? '' : String(tier.maxQuantity),
  price: String(tier.unitPriceToman),
});

export function PriceScheduleEditor({ initial, busy, refusal, onSubmit, onCancel }: EditorProps<PriceScheduleVersionDetail>) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [startsAt, setStartsAt] = useState(isoToLocalInput(initial?.activationStartsAt ?? null));
  const [endsAt, setEndsAt] = useState(isoToLocalInput(initial?.activationEndsAt ?? null));
  const [minQty, setMinQty] = useState(initial ? String(initial.minPurchaseQuantity) : '');
  const [maxQty, setMaxQty] = useState(initial ? String(initial.maxPurchaseQuantity) : '');
  const [presets, setPresets] = useState<number[]>(initial?.uiPresetQuantities ?? []);
  const [tiers, setTiers] = useState<TierRow[]>((initial?.tiers ?? []).map(toRow));
  const [reason, setReason] = useState('');

  const minN = parseWhole(minQty);
  const maxN = parseWhole(maxQty);
  const parsedTiers = tiers.map((row) => ({
    minQuantity: parseWhole(row.min),
    maxQuantity: row.max.trim() === '' ? null : parseWhole(row.max),
    unitPriceToman: parseWhole(row.price),
    maxTyped: row.max.trim() !== '',
  }));
  const tiersParse = parsedTiers.every((t) => t.minQuantity !== null && t.unitPriceToman !== null && (!t.maxTyped || t.maxQuantity !== null));
  const startIso = localInputToIso(startsAt);
  const endIso = localInputToIso(endsAt);

  const cleanTiers: PriceTier[] = tiersParse
    ? parsedTiers.map((t) => ({ minQuantity: t.minQuantity as number, maxQuantity: t.maxQuantity, unitPriceToman: t.unitPriceToman as number }))
    : [];

  /**
   * The contract's own validator, run on what is typed: the same function the
   * server runs, so a gap, an overlap or an out-of-bound tier is named here in
   * the server's own words before anything is sent.
   */
  const problems =
    minN !== null && maxN !== null && tiersParse
      ? validatePriceScheduleTermsV1({
          currency: COMMERCIAL_CURRENCY,
          minPurchaseQuantity: minN,
          maxPurchaseQuantity: maxN,
          uiPresetQuantities: presets,
          tiers: cleanTiers,
        })
      : [];

  const valid =
    displayName.trim().length >= 1 &&
    startIso !== null &&
    (endsAt === '' || endIso !== null) &&
    minN !== null &&
    maxN !== null &&
    tiers.length > 0 &&
    tiersParse &&
    problems.length === 0 &&
    reasonIsValid(reason);

  function patch(id: number, field: 'min' | 'max' | 'price', value: string) {
    setTiers((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  return (
    <form
      className={styles.editor}
      data-testid="price-schedule-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || startIso === null || minN === null || maxN === null) return;
        const body: PriceScheduleVersionBody = {
          displayName: displayName.trim(),
          activationStartsAt: startIso,
          activationEndsAt: endIso,
          minPurchaseQuantity: minN,
          maxPurchaseQuantity: maxN,
          uiPresetQuantities: presets,
          tiers: cleanTiers,
          reason: reason.trim(),
        };
        onSubmit(body);
      }}
    >
      <p className={styles.note}>هیچ قیمت، ردیف یا تعدادی پیشنهاد نمی‌شود. همهٔ مبالغ تومان و عدد صحیح‌اند.</p>
      <Input label="نام نمایشی" value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
      <div className={styles.grid}>
        <Input label="شروع فعال‌سازی" type="datetime-local" dir="ltr" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} disabled={busy} />
        <Input
          label="پایان فعال‌سازی (اختیاری)"
          type="datetime-local"
          dir="ltr"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          disabled={busy}
          hint="اگر خالی بماند، «بدون پایان»."
        />
        <WholeField label="کمترین تعداد خرید" value={minQty} onChange={setMinQty} min={1} max={MAX_CATALOGUE_QUANTITY} disabled={busy} />
        <WholeField label="بیشترین تعداد خرید" value={maxQty} onChange={setMaxQty} min={1} max={MAX_CATALOGUE_QUANTITY} disabled={busy} />
      </div>
      <NumberSetEditor
        legend="تعدادهای پیشنهادی در رابط خرید (فقط نمایشی)"
        unit="عدد"
        values={presets}
        onChange={setPresets}
        min={1}
        max={MAX_CATALOGUE_QUANTITY}
        maxMembers={12}
        disabled={busy}
      />

      <fieldset className={styles.group} data-testid="tier-editor">
        <legend className={styles.legend}>ردیف‌های قیمت</legend>
        <p className={styles.note}>قیمت ثابت یعنی یک ردیف. بیشینهٔ خالی یعنی «بی‌سقف».</p>
        {tiers.length === 0 ? <p className={styles.empty}>هنوز ردیفی ندارد.</p> : null}
        <ol className={styles.tiers}>
          {tiers.map((row, index) => (
            <li key={row.id} className={styles.tier} data-tier={index + 1}>
              <span className={styles.tierIndex}>ردیف {toPersianDigits(index + 1)}</span>
              <WholeField label="از تعداد" value={row.min} onChange={(v) => patch(row.id, 'min', v)} min={1} max={MAX_CATALOGUE_QUANTITY} disabled={busy} />
              <WholeField label="تا تعداد" unit="اختیاری" value={row.max} onChange={(v) => patch(row.id, 'max', v)} min={1} max={MAX_CATALOGUE_QUANTITY} disabled={busy} />
              <WholeField label="قیمت واحد" unit="تومان" value={row.price} onChange={(v) => patch(row.id, 'price', v)} min={0} max={MAX_UNIT_PRICE_TOMAN} disabled={busy} />
              <Button
                type="button"
                variant="ghost"
                inline
                aria-label={`حذف ردیف ${toPersianDigits(index + 1)}`}
                onClick={() => setTiers((rows) => rows.filter((r) => r.id !== row.id))}
                disabled={busy}
              >
                حذف ردیف
              </Button>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="ghost"
          inline
          onClick={() => setTiers((rows) => [...rows, { id: nextTierId++, min: '', max: '', price: '' }])}
          disabled={busy || tiers.length >= 64}
        >
          افزودن ردیف
        </Button>
        {problems.length > 0 ? (
          <div role="alert" className={styles.problems} data-testid="tier-problems">
            <p className={styles.problemsTitle}>این جدول را سرور نمی‌پذیرد:</p>
            <ul>
              {problems.map((p) => (
                <li key={p} dir="ltr">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </fieldset>

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

// ======================================================================= plan

/** One schedule version a new plan draft may point at. */
export interface ScheduleVersionChoice {
  id: string;
  scheduleKey: string;
  version: number;
  displayName: string;
  lifecycleState: string;
}

/**
 * Drafts a NEW plan version, or edits an existing one.
 *
 * The two differ in exactly one field. A new draft PICKS the price-schedule
 * version it points at, which is possible since #271 made schedule reads
 * return each version's id. An existing draft already carries one, and it
 * stays read-only: changing which schedule a drafted plan prices against is a
 * different decision from editing the plan's own terms, and `WritePlanVersionDto`
 * takes the id on the replace too, so silently re-pointing it would be the
 * easiest mistake on this screen to make and the hardest to notice.
 *
 * `scheduleVersionsComplete` says whether every schedule key has reported. It
 * is separate from `scheduleVersions.length` because "not read yet" and "none
 * exist" call for different sentences, and because a list that is merely SHORT
 * is indistinguishable from a complete one unless the picker is told.
 */
export function PlanEditor({
  initial,
  busy,
  refusal,
  onSubmit,
  onCancel,
  creditScheduleKeys,
  scheduleVersions,
  scheduleVersionsComplete,
}: EditorProps<PlanVersion> & {
  creditScheduleKeys: string[];
  scheduleVersions: ScheduleVersionChoice[];
  scheduleVersionsComplete: boolean;
}) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [billing, setBilling] = useState(initial?.billingTermDays == null ? '' : String(initial.billingTermDays));
  const [credits, setCredits] = useState(initial ? String(initial.includedBookingCredits) : '');
  const [seats, setSeats] = useState(initial ? String(initial.staffSeats) : '');
  const [locations, setLocations] = useState(initial ? String(initial.includedLocations) : '');
  const [capabilities, setCapabilities] = useState<string[]>(initial?.capabilityKeys ?? []);
  const [capabilityText, setCapabilityText] = useState('');
  const [creditKey, setCreditKey] = useState(initial?.bookingCreditScheduleKey ?? '');
  const [autoAssignable, setAutoAssignable] = useState<boolean | null>(initial ? initial.autoAssignable : null);
  const [startsAt, setStartsAt] = useState(isoToLocalInput(initial?.activationStartsAt ?? null));
  const [endsAt, setEndsAt] = useState(isoToLocalInput(initial?.activationEndsAt ?? null));
  const [reason, setReason] = useState('');
  /*
   * An existing draft keeps its own id; a new one starts with none chosen.
   * Nothing is pre-selected even when exactly one version exists -- the same
   * rule the seller's workspace chooser follows (`V33-DEC-020`): a default
   * here is a price the administrator did not pick.
   */
  const [pickedScheduleId, setPickedScheduleId] = useState('');
  const creditId = useId();
  const autoName = useId();
  const capabilityId = useId();

  const billingN = billing.trim() === '' ? null : parseWhole(billing);
  const creditsN = parseWhole(credits);
  const seatsN = parseWhole(seats);
  const locationsN = parseWhole(locations);
  const startIso = localInputToIso(startsAt);
  const endIso = localInputToIso(endsAt);
  const capabilityValid = CAPABILITY_KEY_PATTERN.test(capabilityText) && !capabilities.includes(capabilityText);

  const valid =
    displayName.trim().length >= 1 &&
    (billing.trim() === '' || (billingN !== null && billingN >= 1 && billingN <= 3660)) &&
    creditsN !== null &&
    creditsN <= MAX_CATALOGUE_QUANTITY &&
    seatsN !== null &&
    seatsN <= 1_000_000 &&
    locationsN !== null &&
    locationsN <= 1_000_000 &&
    autoAssignable !== null &&
    startIso !== null &&
    (endsAt === '' || endIso !== null) &&
    // A new draft is not valid until a schedule version is chosen.
    (initial !== null || pickedScheduleId !== '') &&
    reasonIsValid(reason);

  const scheduleId = initial ? initial.priceScheduleVersionId : pickedScheduleId;

  return (
    <form
      className={styles.editor}
      data-testid="plan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || creditsN === null || seatsN === null || locationsN === null || autoAssignable === null || startIso === null) return;
        const body: PlanVersionBody = {
          displayName: displayName.trim(),
          billingTermDays: billingN,
          includedBookingCredits: creditsN,
          staffSeats: seatsN,
          includedLocations: locationsN,
          capabilityKeys: capabilities,
          priceScheduleVersionId: scheduleId,
          bookingCreditScheduleKey: creditKey === '' ? null : creditKey,
          autoAssignable,
          activationStartsAt: startIso,
          activationEndsAt: endIso,
          reason: reason.trim(),
        };
        onSubmit(body);
      }}
    >
      <Input label="نام نمایشی" value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
      {initial ? (
        <p className={styles.readOnly}>
          نسخهٔ جدول قیمت: <span dir="ltr">{scheduleId}</span>
          <span className={styles.readOnlyHint}>همان که این پیش‌نویس با آن ساخته شده؛ از اینجا تغییر نمی‌کند.</span>
        </p>
      ) : (
        <Select
          label="نسخهٔ جدول قیمت"
          value={pickedScheduleId}
          onChange={(e) => setPickedScheduleId(e.target.value)}
          disabled={busy}
          /*
           * Three states, and the middle one is why this is not a one-liner.
           * While a schedule key has not reported its versions the list is
           * INCOMPLETE rather than empty, and saying nothing would present a
           * partial catalogue as the whole of it. The earlier wording told the
           * administrator to "open" the schedules section, which is an action
           * that does not exist -- the family reads every key on mount.
           */
          hint={
            !scheduleVersionsComplete
              ? 'فهرست نسخه‌ها کامل نیست. وضعیت خواندن در بخش «جدول‌های قیمت» بالاتر در همین صفحه دیده می‌شود.'
              : scheduleVersions.length === 0
                ? 'هنوز هیچ نسخهٔ جدول قیمتی ساخته نشده است. ابتدا در بخش «جدول‌های قیمت» یکی بسازید.'
                : 'پس از ساخت پیش‌نویس، این انتخاب تغییر نمی‌کند.'
          }
        >
          <option value="">انتخاب کنید</option>
          {scheduleVersions.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {`${choice.scheduleKey} — نسخهٔ ${toPersianDigits(choice.version)} — ${choice.displayName} (${lifecycleView(choice.lifecycleState).label})`}
            </option>
          ))}
        </Select>
      )}
      <div className={styles.grid}>
        <WholeField
          label="دورهٔ صورت‌حساب"
          unit="روز، اختیاری"
          hint="اگر خالی بماند، دورهٔ تکرارشونده ندارد."
          value={billing}
          onChange={setBilling}
          min={1}
          max={3660}
          disabled={busy}
        />
        <WholeField label="اعتبار رزرو همراه طرح" value={credits} onChange={setCredits} min={0} max={MAX_CATALOGUE_QUANTITY} disabled={busy} />
        <WholeField label="جای کارمند" value={seats} onChange={setSeats} min={0} max={1_000_000} disabled={busy} />
        <WholeField label="شعبه" value={locations} onChange={setLocations} min={0} max={1_000_000} disabled={busy} />
      </div>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>قابلیت‌ها</legend>
        {capabilities.length === 0 ? <p className={styles.empty}>هیچ قابلیتی.</p> : null}
        <ul className={styles.chips}>
          {capabilities.map((key) => (
            <li key={key} className={styles.chip}>
              <span dir="ltr">{key}</span>
              <Button type="button" variant="ghost" inline aria-label={`حذف ${key}`} onClick={() => setCapabilities((keys) => keys.filter((k) => k !== key))} disabled={busy}>
                حذف
              </Button>
            </li>
          ))}
        </ul>
        <label htmlFor={capabilityId} className={styles.fieldLabel}>
          افزودن قابلیت (حروف کوچک لاتین، رقم و زیرخط)
        </label>
        <div className={styles.addRow}>
          <input id={capabilityId} className={styles.textInput} dir="ltr" value={capabilityText} onChange={(e) => setCapabilityText(e.target.value)} disabled={busy} />
          <Button
            type="button"
            variant="ghost"
            inline
            disabled={busy || !capabilityValid}
            onClick={() => {
              setCapabilities((keys) => [...keys, capabilityText]);
              setCapabilityText('');
            }}
          >
            افزودن
          </Button>
        </div>
      </fieldset>

      <label htmlFor={creditId} className={styles.fieldLabel}>
        جدول قیمتِ اعتبار اضافه (اختیاری)
      </label>
      <select id={creditId} className={styles.select} value={creditKey} onChange={(e) => setCreditKey(e.target.value)} disabled={busy}>
        <option value="">بدون فروش اعتبار اضافه</option>
        {/* A new draft carries nothing; an existing one keeps its own key on the list even if that schedule's purpose has since changed. */}
        {[...new Set([...creditScheduleKeys, ...(initial?.bookingCreditScheduleKey ? [initial.bookingCreditScheduleKey] : [])])].map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>واگذاری خودکار</legend>
        {([true, false] as const).map((value) => (
          <label key={String(value)} className={styles.radio}>
            <input type="radio" name={autoName} checked={autoAssignable === value} onChange={() => setAutoAssignable(value)} disabled={busy} />
            <span>{value ? 'بله — بی‌نیاز از انتخاب فروشنده واگذار می‌شود' : 'خیر'}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.grid}>
        <Input label="شروع فعال‌سازی" type="datetime-local" dir="ltr" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} disabled={busy} />
        <Input label="پایان فعال‌سازی (اختیاری)" type="datetime-local" dir="ltr" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} disabled={busy} />
      </div>

      <ReasonField value={reason} onChange={setReason} disabled={busy} />
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <div className={styles.actions}>
        <Button type="submit" inline disabled={!valid || busy} loading={busy}>
          {/* Same wording as the schedule editor above: a new draft is submitted, an existing one saved. */}
          {initial ? 'ذخیرهٔ پیش‌نویس' : 'ثبت پیش‌نویس'}
        </Button>
        <Button type="button" variant="ghost" inline onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </form>
  );
}

// ================================================================== summaries

export function PlanSummary({ version }: { version: PlanVersion }) {
  return (
    <ul className={styles.summary}>
      <li>
        <strong>{version.displayName}</strong>
      </li>
      <li>
        اعتبار {toPersianDigits(version.includedBookingCredits)} · کارمند {toPersianDigits(version.staffSeats)} · شعبه {toPersianDigits(version.includedLocations)}
        {version.billingTermDays !== null ? ` · دوره ${toPersianDigits(version.billingTermDays)} روز` : ' · بدون دورهٔ تکرارشونده'}
      </li>
      <li data-auto-assignable={version.autoAssignable}>واگذاری خودکار: {version.autoAssignable ? 'بله' : 'خیر'}</li>
      {version.capabilityKeys.length > 0 ? (
        <li>
          قابلیت‌ها: <span dir="ltr">{version.capabilityKeys.join(', ')}</span>
        </li>
      ) : null}
      {version.bookingCreditScheduleKey ? (
        <li>
          اعتبار اضافه: <span dir="ltr">{version.bookingCreditScheduleKey}</span>
        </li>
      ) : null}
    </ul>
  );
}

export function tierSummary(tiers: PriceTier[]): string {
  return tiers
    .map((t) => `${toPersianDigits(t.minQuantity)}${t.maxQuantity === null ? '+' : `–${toPersianDigits(t.maxQuantity)}`}: ${formatToman(t.unitPriceToman)} تومان`)
    .join(' · ');
}
