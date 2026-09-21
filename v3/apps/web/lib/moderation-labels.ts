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
