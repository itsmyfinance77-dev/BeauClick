import type { BadgeTone } from '@/components/kit';
import type { PrivacyRequestKind } from './privacy-api';

/**
 * How the privacy page names what the server sends.
 *
 * Two tables, each pinned by `privacy-labels.spec.ts` to a list the server
 * declares: the request statuses (`DATA_REQUEST_STATUSES`) and the module keys
 * every export and erasure walks (`moduleKey`). A value the server adds cannot
 * reach a customer as an English key, and one it drops cannot linger here.
 * An unknown value is shown under a neutral word, never as a raw key.
 */

/**
 * A request's state as the CUSTOMER sees it — which is not always one value per
 * status. `pending` and `processing` are two states to the server and one to a
 * person waiting for a file, and the two kinds mean different things by the
 * same word (`pending` on an erasure is the grace window, on an export it is
 * the queue).
 */
export interface StatusView {
  label: string;
  tone: BadgeTone;
}

const EXPORT_STATUS: Record<string, StatusView> = {
  pending: { label: 'در حال آماده‌سازی', tone: 'primary' },
  processing: { label: 'در حال آماده‌سازی', tone: 'primary' },
  ready: { label: 'آماده', tone: 'success' },
  expired: { label: 'منقضی‌شده', tone: 'neutral' },
  failed: { label: 'ناموفق', tone: 'error' },
};

const ERASURE_STATUS: Record<string, StatusView> = {
  pending: { label: 'در انتظار اجرا', tone: 'warning' },
  processing: { label: 'در حال اجرا', tone: 'warning' },
  completed: { label: 'انجام شد', tone: 'neutral' },
  cancelled: { label: 'لغو شد', tone: 'neutral' },
  failed: { label: 'ناموفق', tone: 'error' },
};

export const EXPORT_STATUS_LABELS = EXPORT_STATUS;
export const ERASURE_STATUS_LABELS = ERASURE_STATUS;

export const UNKNOWN_STATUS_LABEL = 'نامشخص';

export function requestStatusView(kind: PrivacyRequestKind, status: string): StatusView {
  return (kind === 'export' ? EXPORT_STATUS : ERASURE_STATUS)[status] ?? { label: UNKNOWN_STATUS_LABEL, tone: 'neutral' };
}

/** The platform's modules, in the customer's words. One entry per `moduleKey` the server registers. */
export const MODULE_LABEL: Record<string, string> = {
  admin: 'مدیریت',
  ai: 'دستیار هوشمند',
  analytics: 'آمار',
  booking: 'رزروها',
  business: 'کسب‌وکار',
  chat: 'گفتگو',
  commerce: 'سفارش‌ها',
  commercial: 'کاتالوگ تجاری',
  'commercial-collection-policy-assignment': 'انتساب سیاست دریافت',
  'commercial-commission-policy': 'سیاست کمیسیون',
  'commercial-enforcement': 'اعمال اعتبار رزرو',
  'commercial-outcome-policy': 'سیاست پیامد',
  'commercial-outcome-policy-assignment': 'انتساب سیاست پیامد',
  'commercial-settlement-schedule': 'برنامهٔ تسویه',
  'commercial-subscription': 'اشتراک',
  financial: 'سوابق مالی',
  identity: 'حساب کاربری',
  journey: 'مسیر زیبایی',
  loyalty: 'باشگاه مشتریان',
  media: 'رسانه‌ها',
  notification: 'اعلان‌ها',
  payment: 'پرداخت‌ها',
  privacy: 'حریم خصوصی',
  provider: 'پروفایل متخصص',
  referral: 'دعوت دوستان',
  search: 'جست‌وجو',
  waitlist: 'لیست انتظار',
  wishlist: 'علاقه‌مندی‌ها',
};

/** For a module this client has never heard of: never the raw key as the heading. */
export const UNKNOWN_MODULE_LABEL = 'بخش دیگر';

export function moduleLabel(moduleKey: string): string {
  return MODULE_LABEL[moduleKey] ?? UNKNOWN_MODULE_LABEL;
}

/**
 * The modules whose retained data the spec explains in one plain sentence
 * («سابقهٔ پرداخت شما نگه داشته می‌شود چون قانوناً الزامی است»). Every other
 * module's retention is shown with the server's own stated reason and nothing
 * added: the reasons are the platform's, and inventing a legal claim for a
 * module the spec does not make one for would be the worse mistake.
 */
export const LEGALLY_RETAINED_MODULES: readonly string[] = ['financial', 'payment'];
