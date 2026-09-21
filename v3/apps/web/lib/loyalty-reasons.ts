/**
 * How a loyalty ledger row is named on screen.
 *
 * `reason` is a stable enum-shaped key the platform writes
 * (`LOYALTY_REASONS` in `loyalty.config.ts`). This page had a table of five,
 * one of which — `referral_qualified` — the server has never written, while
 * four it does write (both referral rewards and both reversals) fell through
 * to the raw key, so a customer whose friend signed up read
 * `referral_referrer_reward` in the middle of a Persian list.
 *
 * `loyalty-reasons.spec.ts` reads the server's table and fails if the two
 * drift apart, in either direction.
 */
export const LOYALTY_REASON_LABEL: Record<string, string> = {
  booking_completed: 'انجام خدمت',
  review_submitted: 'ثبت نظر',
  order_completed: 'خرید',
  referral_referrer_reward: 'پاداش معرفی دوستان',
  referral_referee_reward: 'پاداش ورود با دعوت‌نامه',
  referral_referrer_reversal: 'برگشت پاداش معرفی',
  referral_referee_reversal: 'برگشت پاداش دعوت‌نامه',
  manual_adjustment: 'تعدیل دستی',
};

/** For a reason this client has never heard of: never the raw key. */
export const UNKNOWN_REASON_LABEL = 'امتیاز باشگاه';

export function loyaltyReasonLabel(reason: string): string {
  return LOYALTY_REASON_LABEL[reason] ?? UNKNOWN_REASON_LABEL;
}
