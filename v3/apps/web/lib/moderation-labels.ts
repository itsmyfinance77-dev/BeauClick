import type { BadgeTone } from '@/components/kit';

/**
 * How the operator queues name what the server sends — `/admin/media`,
 * `/admin/reviews`, `/admin/privacy` and `/admin/chat-reports` (#238).
 *
 * Every table here is keyed by a server enum that `moderation-labels.spec.ts`
 * reads from source, so a value the server adds cannot reach an operator as an
 * English key, and one it drops cannot linger here. Every lookup has a neutral
 * Persian fallback: an unknown value is shown as "unknown", never as its key.
 */

export interface LabelView {
  label: string;
  tone: BadgeTone;
}

// ------------------------------------------------------------------ media

/** `ABUSE_REPORT_REASONS` (`libs/media/src/entities/media-abuse-report.entity.ts`). */
export const MEDIA_REPORT_REASON_LABEL: Record<string, string> = {
  not_own_work: 'اثرِ شخص دیگری است',
  explicit: 'محتوای نامناسب',
  misleading: 'گمراه‌کننده',
  personal_data: 'دادهٔ شخصی',
  other: 'سایر',
};

export const UNKNOWN_REASON_LABEL = 'دلیل نامشخص';

export function mediaReportReasonLabel(reason: string): string {
  return MEDIA_REPORT_REASON_LABEL[reason] ?? UNKNOWN_REASON_LABEL;
}

export const UNKNOWN_STATUS_LABEL = 'نامشخص';

// ---------------------------------------------------------------- reviews

/** `REVIEW_STATUSES` (`services/provider/src/entities/review.entity.ts`). */
export const REVIEW_STATUS_LABEL: Record<string, LabelView> = {
  published: { label: 'منتشرشده', tone: 'success' },
  hidden: { label: 'پنهان', tone: 'neutral' },
};

export function reviewStatusView(status: string): LabelView {
  return REVIEW_STATUS_LABEL[status] ?? { label: UNKNOWN_STATUS_LABEL, tone: 'neutral' };
}

// ---------------------------------------------------------------- privacy

/**
 * `DATA_REQUEST_STATUSES` (`services/privacy/src/entities/data-request.entity.ts`),
 * as an OPERATOR reads them: every status its own word. The customer's page
 * (`privacy-labels.ts`) folds `pending` and `processing` of an export into one
 * state because to a person waiting for a file they are one; an operator
 * watching for a stuck sweep needs them apart. The order is the filter's.
 */
export const PRIVACY_STATUS_LABEL: Record<string, LabelView> = {
  pending: { label: 'در انتظار', tone: 'warning' },
  processing: { label: 'در حال پردازش', tone: 'primary' },
  ready: { label: 'آماده', tone: 'success' },
  completed: { label: 'انجام شد', tone: 'success' },
  expired: { label: 'منقضی شد', tone: 'neutral' },
  cancelled: { label: 'لغو شد', tone: 'neutral' },
  failed: { label: 'ناموفق', tone: 'error' },
};

export function privacyStatusView(status: string): LabelView {
  return PRIVACY_STATUS_LABEL[status] ?? { label: UNKNOWN_STATUS_LABEL, tone: 'neutral' };
}

/** `DATA_REQUEST_KINDS`. */
export const PRIVACY_KIND_LABEL: Record<string, string> = {
  export: 'دریافت نسخهٔ داده',
  erasure: 'حذف حساب',
};

export const UNKNOWN_KIND_LABEL = 'نوع نامشخص';

export function privacyKindLabel(kind: string): string {
  return PRIVACY_KIND_LABEL[kind] ?? UNKNOWN_KIND_LABEL;
}
