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

// ------------------------------------------------------------------- chat

/** `CHAT_REPORT_REASONS` (`packages/chat-contract/src/chat-contract.ts`). */
export const CHAT_REPORT_REASON_LABEL: Record<string, string> = {
  harassment: 'آزار و مزاحمت',
  spam: 'هرزنامه',
  scam_or_fraud: 'کلاهبرداری',
  explicit: 'محتوای نامناسب',
  personal_data: 'دادهٔ شخصی',
  off_platform_payment: 'پرداخت بیرون از پلتفرم',
  other: 'سایر',
};

export function chatReportReasonLabel(reason: string): string {
  return CHAT_REPORT_REASON_LABEL[reason] ?? UNKNOWN_REASON_LABEL;
}

/** `CHAT_REPORT_STATUSES`. */
export const CHAT_REPORT_STATUS_LABEL: Record<string, LabelView> = {
  open: { label: 'باز', tone: 'warning' },
  upheld: { label: 'تأییدشده', tone: 'error' },
  rejected: { label: 'ردشده', tone: 'neutral' },
};

export function chatReportStatusView(status: string): LabelView {
  return CHAT_REPORT_STATUS_LABEL[status] ?? { label: UNKNOWN_STATUS_LABEL, tone: 'neutral' };
}

/** `CHAT_MODERATION_ACTIONS` — the three things an upheld report may do. The order is the form's; the first is the server's default. */
export const CHAT_ACTION_LABEL: Record<string, string> = {
  warn_sender: 'اخطار به فرستنده',
  close_conversation: 'بستن گفتگو برای ارسال',
  restrict_sender: 'محدود کردن ارسالِ فرستنده',
};

export const UNKNOWN_ACTION_LABEL = 'اقدام نامشخص';

export function chatActionLabel(action: string): string {
  return CHAT_ACTION_LABEL[action] ?? UNKNOWN_ACTION_LABEL;
}

/**
 * The chat routes' ONE refusal (`NOT_FOUND_OR_NOT_YOURS`, 404), in words.
 *
 * The same response means a missing report, a foreign one, one whose 30-day
 * post-decision access has lapsed, and one a colleague decided a moment ago.
 * The copy claims only what all four share — never that a colleague decided
 * it (spec 37, "Concurrent-decision conflict").
 */
export const CHAT_REPORT_UNAVAILABLE = 'این گزارش دیگر برای تصمیم‌گیری در دسترس نیست. صف را تازه کنید.';

/** The same refusal on OPENING a report. */
export const CHAT_REPORT_UNREADABLE = 'این گزارش دیگر در دسترس نیست. صف را تازه کنید.';
