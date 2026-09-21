import { SERIES_EVENTS, type SeriesEvent } from './pro-api';

/**
 * How the professional's analytics are named on screen.
 *
 * Every key here is one the server sends (`metrics.service.ts`,
 * `analytics.controller.ts`); `analytics-labels.spec.ts` reads those sources
 * and fails on drift in either direction. The revenue table used to carry
 * `netToman` and `averageOrderToman`, which the server has never sent, so a
 * reader believed two figures existed that could never render.
 */
export const SERIES_EVENT_LABEL: Record<SeriesEvent, string> = {
  BookingCreated: 'رزروهای ثبت‌شده',
  BookingCompleted: 'نوبت‌های انجام‌شده',
  BookingCancelled: 'رزروهای لغوشده',
  ProviderProfileViewed: 'بازدید از پروفایل',
  OrderPaid: 'فروش (پرداخت‌های موفق)',
  SearchPerformed: 'جست‌وجوها',
};

/** The funnel counters the page shows as cards, in order. `completionRate` is shown separately. */
export const FUNNEL_LABEL: Record<string, string> = {
  created: 'رزرو ثبت‌شده',
  confirmed: 'تأیید شده',
  completed: 'انجام شده',
  cancelled: 'لغو شده',
  expired: 'منقضی شده',
  profileViews: 'بازدید پروفایل',
};

export const REVENUE_LABEL: Record<string, string> = {
  paidOrders: 'سفارش‌های پرداخت‌شده',
  grossToman: 'فروش ناخالص',
  refundedToman: 'بازگشت وجه',
};

/** A neutral Persian phrase for a revenue key this client has never heard of — never the raw key. */
export const UNKNOWN_REVENUE_LABEL = 'شاخص مالی';

export function revenueLabel(key: string): string {
  return REVENUE_LABEL[key] ?? UNKNOWN_REVENUE_LABEL;
}

/** The server names its money measures `…Toman`; a count such as `paidOrders` is not money. */
export function revenueIsMoney(key: string): boolean {
  return /Toman$/.test(key);
}

/**
 * Events the server accepts a series for but that nothing ever records.
 *
 * `recordProfileView` exists in `phase3-api.ts` and no page calls it, so the
 * profile-view counter is zero for every professional. Showing that zero as a
 * fact would be false; the page labels it «به‌زودی» instead
 * (`07_PRO_ANALYTICS.md`). Turning it on is a product decision.
 */
export const NOT_RECORDED_YET: ReadonlySet<string> = new Set(['profileViews', 'ProviderProfileViewed']);

/**
 * What one bar of the daily trend measures.
 *
 * `OrderPaid`'s metric is the order total in Toman, so its daily `sum` is gross
 * sales and is what the chart plots (`24_MONEYCHART_DECISION.md`: "height by
 * gross sales"), with the order count as the detail. Every other event is a
 * count; its `sum` is zero, which would draw a flat chart.
 */
export function seriesMeasure(event: SeriesEvent): { field: 'count' | 'sum'; money: boolean } {
  return event === 'OrderPaid' ? { field: 'sum', money: true } : { field: 'count', money: false };
}

export { SERIES_EVENTS };
