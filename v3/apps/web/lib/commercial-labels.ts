import type {
  BookingCollectionDepositKind,
  BookingCollectionMode,
  BookingCollectionPercentageBase,
  BookingOutcomeRetentionKind,
  CatalogueLifecycleState,
  LegalEvidenceReferenceKind,
  LegalEvidenceStatus,
  LegalEvidenceSubject,
  PriceSchedulePurpose,
} from '@beauclick/commercial-policy-contract';

/**
 * How the admin commercial screens name what the server sends (#239).
 *
 * Tables keyed by a contract vocabulary are typed `Record<ThatType, …>`, so the
 * compiler refuses one that misses a value; `commercial-labels.spec.ts` also
 * compares each against the contract's own list at runtime, and the enforcement
 * states — which live in the service, not the contract — against the service
 * source. Every lookup falls back to a neutral Persian word, never the raw key.
 */

export const UNKNOWN_LABEL = 'نامشخص';

// ------------------------------------------------------------- lifecycle

/**
 * The three STORED states. Text and a distinct shape each, so the state never
 * rests on colour: ◇ open, ● fixed, ■ closed.
 */
export const LIFECYCLE_LABEL: Record<CatalogueLifecycleState, { label: string; glyph: string }> = {
  draft: { label: 'پیش‌نویس', glyph: '◇' },
  published: { label: 'منتشرشده', glyph: '●' },
  retired: { label: 'بازنشسته', glyph: '■' },
};

export function lifecycleView(state: string): { label: string; glyph: string } {
  return (LIFECYCLE_LABEL as Record<string, { label: string; glyph: string }>)[state] ?? { label: UNKNOWN_LABEL, glyph: '?' };
}

/**
 * The two DERIVED states, computed from a published version's activation
 * window — never stored, and never shown as if the server had reported them.
 */
export const DERIVED_LABEL = {
  active: { label: 'مؤثر اکنون', glyph: '▶' },
  scheduled: { label: 'در انتظار شروع', glyph: '⏵' },
  superseded: { label: 'پایان‌یافته', glyph: '⏹' },
} as const;
export type DerivedState = keyof typeof DERIVED_LABEL;

// ----------------------------------------------------------- catalogue

export const SCHEDULE_PURPOSE_LABEL: Record<PriceSchedulePurpose, string> = {
  seller_plan: 'قیمت طرح فروشنده',
  booking_credit: 'قیمت اعتبار رزرو',
};

export function schedulePurposeLabel(purpose: string): string {
  return (SCHEDULE_PURPOSE_LABEL as Record<string, string>)[purpose] ?? UNKNOWN_LABEL;
}

// ------------------------------------------------- collection policies

export const COLLECTION_MODE_LABEL: Record<BookingCollectionMode, { label: string; description: string }> = {
  pay_at_venue: { label: 'پرداخت در محل', description: 'مشتری هنگام نوبت و در محل پرداخت می‌کند؛ پیش‌پرداختی گرفته نمی‌شود.' },
  deposit_online_balance_at_venue: {
    label: 'پیش‌پرداخت آنلاین، مانده در محل',
    description: 'بخشی آنلاین دریافت می‌شود و باقی در محل. این حالت یک قاعدهٔ پیش‌پرداخت لازم دارد.',
  },
  full_payment_online: { label: 'پرداخت کامل آنلاین', description: 'همهٔ مبلغ هنگام رزرو آنلاین دریافت می‌شود؛ پیش‌پرداختی جدا در کار نیست.' },
};

export function collectionModeLabel(mode: string): string {
  return (COLLECTION_MODE_LABEL as Record<string, { label: string }>)[mode]?.label ?? UNKNOWN_LABEL;
}

export const DEPOSIT_KIND_LABEL: Record<BookingCollectionDepositKind, string> = {
  none: 'بدون پیش‌پرداخت',
  fixed: 'مبلغ ثابت',
  percentage: 'درصدی از مبلغ',
};

/**
 * One line each, so the difference is readable without outside knowledge
 * (spec 44 §3). The two are the order's `subtotalToman` and `totalToman` —
 * `bookingCollectionAmountsV1` reads exactly those — so the lines say that and
 * nothing more. Neither is pre-selected anywhere.
 */
export const PERCENTAGE_BASE_LABEL: Record<BookingCollectionPercentageBase, { label: string; description: string }> = {
  service_subtotal: { label: 'جمع پیش از تعدیل‌ها', description: 'جمعِ قیمت خدمات در سفارش، پیش از هر تخفیف یا هزینه.' },
  service_total: { label: 'مبلغ نهایی سفارش', description: 'مبلغ سفارش پس از اعمال تخفیف‌ها و هزینه‌ها.' },
};

// --------------------------------------------------- outcome policies

/** How an administrator names each retention shape while composing it. */
export const RETENTION_KIND_LABEL: Record<BookingOutcomeRetentionKind, string> = {
  none: 'هیچ مبلغی نگه داشته نمی‌شود',
  percentage_of_collected: 'درصدی از مبلغ وصول‌شده',
  fixed_toman: 'مبلغ ثابت به تومان',
  full_collected: 'همهٔ مبلغ وصول‌شده',
};

export const EVIDENCE_SUBJECT_LABEL: Record<LegalEvidenceSubject, string> = {
  retention_cap: 'سقف نگه‌داشت',
  withdrawal_posture: 'موضع انصراف',
  policy_copy: 'متن سیاست برای مشتری',
  case_file_retention: 'نگه‌داری پرونده',
};

export function evidenceSubjectLabel(subject: string): string {
  return (EVIDENCE_SUBJECT_LABEL as Record<string, string>)[subject] ?? UNKNOWN_LABEL;
}

export const EVIDENCE_REFERENCE_KIND_LABEL: Record<LegalEvidenceReferenceKind, string> = {
  document_reference: 'ارجاع به سند',
  counsel_letter_reference: 'ارجاع به نامهٔ مشاور حقوقی',
  internal_ticket: 'تیکت داخلی',
};

export function evidenceReferenceKindLabel(kind: string): string {
  return (EVIDENCE_REFERENCE_KIND_LABEL as Record<string, string>)[kind] ?? UNKNOWN_LABEL;
}

/** `recorded → retired`, one way. */
export const EVIDENCE_STATUS_LABEL: Record<LegalEvidenceStatus, { label: string; glyph: string }> = {
  recorded: { label: 'ثبت‌شده', glyph: '●' },
  retired: { label: 'بازنشسته', glyph: '■' },
};

export function evidenceStatusView(status: string): { label: string; glyph: string } {
  return (EVIDENCE_STATUS_LABEL as Record<string, { label: string; glyph: string }>)[status] ?? { label: UNKNOWN_LABEL, glyph: '?' };
}

// ------------------------------------------------ enforcement control

/** `ENFORCEMENT_ROLLOUT_STATES` (service source, not the contract). */
export const ROLLOUT_STATE_LABEL: Record<string, string> = {
  inactive: 'غیرفعال — فروشندگان موجود هنوز معاف‌اند',
  active: 'فعال — اعتبار رزرو برای فروشندگان مشمول اعمال می‌شود',
};

/** `KILL_SWITCH_STATES`. */
export const KILL_SWITCH_LABEL: Record<string, string> = {
  released: 'آزاد',
  engaged: 'درگیر — اعمال اعتبار در همهٔ پلتفرم متوقف است',
};

export function rolloutStateLabel(state: string): string {
  return ROLLOUT_STATE_LABEL[state] ?? UNKNOWN_LABEL;
}

export function killSwitchLabel(state: string): string {
  return KILL_SWITCH_LABEL[state] ?? UNKNOWN_LABEL;
}
