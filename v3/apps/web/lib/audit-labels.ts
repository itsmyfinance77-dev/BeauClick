/**
 * How the audit log names what the server records.
 *
 * The log shows every privileged action the platform has ever taken, and the
 * server writes about sixty kinds of them. This page used to name ten, so every
 * other row — every commercial-policy change, every erasure, every business
 * staff grant — carried a raw dotted English key as its title.
 *
 * Two guards keep that from coming back (`audit-labels.spec.ts`):
 *
 *  - every action the server DECLARES (`@AuditAction('…')` and the seven
 *    `*_AUDIT_ACTIONS` constant objects) has a label here, and
 *  - every label here is an action the server can still write, so a renamed
 *    action does not leave a dead entry behind.
 *
 * An action the client has never heard of is not an error: it is shown under a
 * neutral title with its exact code beside it (the page always prints the code —
 * on a forensic screen the precise identifier matters more than the prose).
 */
export const ACTION_LABELS: Record<string, string> = {
  // identity
  'identity.role_granted': 'اعطای نقش',
  'identity.role_revoked': 'لغو نقش',
  'identity.phone_conflict_resolved': 'رفع تعارض شماره',
  'identity.business_owner_role_granted': 'اعطای نقش مالک کسب‌وکار',
  'identity.professional_owner_role_granted': 'اعطای نقش مالک متخصص',

  // provider
  'provider.verification_decided': 'تصمیم دربارهٔ احراز هویت',
  'provider.verification_approved': 'تأیید احراز هویت',
  'provider.verification_rejected': 'رد احراز هویت',
  'provider.review_moderated': 'بررسی نظر',
  'provider.review_hidden': 'پنهان‌کردن نظر',
  'provider.review_published': 'انتشار نظر',

  // financial
  'financial.settlement_created': 'ثبت تسویه',
  'financial.settlement_reversed': 'برگشت تسویه',

  // search and notification
  'search.reindex_triggered': 'بازسازی نمایه جست‌وجو',
  'search.projection_rebuilt': 'بازسازی کامل پروجکشن جست‌وجو',
  'notification.retry_due_triggered': 'تلاش مجدد ارسال اعلان‌ها',

  // privacy
  'privacy.export_requested': 'درخواست خروجی داده‌ها',
  'privacy.erasure_requested': 'درخواست پاک‌سازی داده‌ها',
  'privacy.erasure_cancelled': 'لغو پاک‌سازی داده‌ها',
  'privacy.erasure_executed': 'اجرای پاک‌سازی داده‌ها',

  // chat and media moderation
  'chat.report.read': 'مشاهدهٔ گزارش گفتگو',
  'chat.report.decided': 'تصمیم دربارهٔ گزارش گفتگو',
  'media.abuse_report_decided': 'تصمیم دربارهٔ گزارش رسانه',
  'media.abuse_report_upheld': 'پذیرش گزارش رسانه',
  'media.abuse_report_rejected': 'رد گزارش رسانه',

  // business
  'business.classification_replaced': 'جایگزینی طبقه‌بندی کسب‌وکار',
  'business.staff_invited': 'دعوت عضو کسب‌وکار',
  'business.staff_grant_granted': 'اعطای اختیار به عضو کسب‌وکار',
  'business.staff_grant_revoked': 'بازپس‌گیری اختیار عضو کسب‌وکار',
  'business.location_created': 'ساخت شعبه',
  'business.location_renamed': 'تغییر نام شعبه',
  'business.location_suspended': 'تعلیق شعبه',
  'business.location_reactivated': 'فعال‌سازی دوبارهٔ شعبه',
  'business.location_closed': 'بستن شعبه',
  'business.location_resource_created': 'ساخت منبع شعبه',
  'business.location_resource_renamed': 'تغییر نام منبع شعبه',
  'business.location_resource_retired': 'بازنشستگی منبع شعبه',
  'business.service_resource_requirement_set': 'تعیین نیازمندی منبع خدمت',
  'business.service_resource_requirement_changed': 'تغییر نیازمندی منبع خدمت',
  'business.service_resource_requirement_cleared': 'حذف نیازمندی منبع خدمت',
  'business.staff_location_assigned': 'تخصیص عضو به شعبه',
  'business.staff_location_cleared': 'حذف تخصیص عضو از شعبه',

  // commercial: plans
  'commercial.plan_created': 'ساخت طرح',
  'commercial.plan_version_drafted': 'پیش‌نویس نسخهٔ طرح',
  'commercial.plan_version_edited': 'ویرایش نسخهٔ طرح',
  'commercial.plan_version_discarded': 'دورانداختن نسخهٔ طرح',
  'commercial.plan_version_published': 'انتشار نسخهٔ طرح',
  'commercial.plan_version_retired': 'بازنشستگی نسخهٔ طرح',

  // commercial: price schedules
  'commercial.price_schedule_created': 'ساخت جدول قیمت',
  'commercial.price_schedule_version_drafted': 'پیش‌نویس نسخهٔ جدول قیمت',
  'commercial.price_schedule_version_edited': 'ویرایش نسخهٔ جدول قیمت',
  'commercial.price_schedule_version_discarded': 'دورانداختن نسخهٔ جدول قیمت',
  'commercial.price_schedule_version_published': 'انتشار نسخهٔ جدول قیمت',
  'commercial.price_schedule_version_retired': 'بازنشستگی نسخهٔ جدول قیمت',

  // commercial: collection policies
  'commercial.collection_policy_created': 'ساخت سیاست دریافت',
  'commercial.collection_policy_version_drafted': 'پیش‌نویس نسخهٔ سیاست دریافت',
  'commercial.collection_policy_version_updated': 'به‌روزرسانی نسخهٔ سیاست دریافت',
  'commercial.collection_policy_version_discarded': 'دورانداختن نسخهٔ سیاست دریافت',
  'commercial.collection_policy_version_published': 'انتشار نسخهٔ سیاست دریافت',
  'commercial.collection_policy_version_retired': 'بازنشستگی نسخهٔ سیاست دریافت',

  // commercial: commission policies
  'commercial.commission_policy_created': 'ساخت سیاست کمیسیون',
  'commercial.commission_version_drafted': 'پیش‌نویس نسخهٔ سیاست کمیسیون',
  'commercial.commission_version_updated': 'به‌روزرسانی نسخهٔ سیاست کمیسیون',
  'commercial.commission_version_published': 'انتشار نسخهٔ سیاست کمیسیون',
  'commercial.commission_version_retired': 'بازنشستگی نسخهٔ سیاست کمیسیون',
  'commercial.commission_version_discarded': 'دورانداختن نسخهٔ سیاست کمیسیون',

  // commercial: booking-credit enforcement
  'commercial.enforcement_parties_governed': 'مشمول‌کردن طرف‌ها در اعمال اعتبار رزرو',
  'commercial.enforcement_parties_exempted': 'معاف‌کردن طرف‌ها از اعمال اعتبار رزرو',
  'commercial.enforcement_kill_switch_engaged': 'فعال‌سازی کلید اضطراری اعمال اعتبار',
  'commercial.enforcement_kill_switch_released': 'آزادسازی کلید اضطراری اعمال اعتبار',
  'commercial.enforcement_activated': 'فعال‌سازی اعمال اعتبار رزرو',
  'commercial.enforcement_party_governed_at_creation': 'مشمول‌شدن طرف هنگام ایجاد',

  // commercial: outcome policies and customer-facing copy
  'commercial.outcome_policy_created': 'ساخت سیاست پیامد',
  'commercial.outcome_policy_version_drafted': 'پیش‌نویس نسخهٔ سیاست پیامد',
  'commercial.outcome_policy_version_updated': 'به‌روزرسانی نسخهٔ سیاست پیامد',
  'commercial.outcome_policy_version_published': 'انتشار نسخهٔ سیاست پیامد',
  'commercial.outcome_policy_version_retired': 'بازنشستگی نسخهٔ سیاست پیامد',
  'commercial.outcome_policy_version_discarded': 'دورانداختن نسخهٔ سیاست پیامد',
  'commercial.outcome_policy_assigned': 'انتساب سیاست پیامد',
  'commercial.outcome_policy_assignment_superseded': 'جایگزینی انتساب سیاست پیامد',
  'commercial.customer_policy_copy_created': 'ساخت متن سیاست برای مشتری',
  'commercial.customer_policy_copy_version_drafted': 'پیش‌نویس نسخهٔ متن سیاست برای مشتری',
  'commercial.customer_policy_copy_version_updated': 'به‌روزرسانی نسخهٔ متن سیاست برای مشتری',
  'commercial.customer_policy_copy_version_published': 'انتشار نسخهٔ متن سیاست برای مشتری',
  'commercial.customer_policy_copy_version_retired': 'بازنشستگی نسخهٔ متن سیاست برای مشتری',
  'commercial.customer_policy_copy_version_discarded': 'دورانداختن نسخهٔ متن سیاست برای مشتری',
  'commercial.legal_evidence_recorded': 'ثبت مدرک حقوقی',
  'commercial.legal_evidence_retired': 'بازنشستگی مدرک حقوقی',

  // commercial: settlement schedules
  'commercial.settlement_schedule_created': 'ساخت برنامهٔ تسویه',
  'commercial.settlement_version_drafted': 'پیش‌نویس نسخهٔ برنامهٔ تسویه',
  'commercial.settlement_version_updated': 'به‌روزرسانی نسخهٔ برنامهٔ تسویه',
  'commercial.settlement_version_published': 'انتشار نسخهٔ برنامهٔ تسویه',
  'commercial.settlement_version_retired': 'بازنشستگی نسخهٔ برنامهٔ تسویه',
  'commercial.settlement_version_discarded': 'دورانداختن نسخهٔ برنامهٔ تسویه',
  'commercial.seller_risk_class_assigned': 'تعیین طبقهٔ ریسک فروشنده',

  // commercial: subscriptions and booking credits
  'commercial.subscription_assigned': 'انتساب اشتراک',
  'commercial.subscription_activated': 'فعال‌سازی اشتراک',
  'commercial.subscription_superseded': 'جایگزینی اشتراک',
  'commercial.subscription_cancelled': 'لغو اشتراک',
  'commercial.credits_granted': 'اعطای اعتبار رزرو',
  'commercial.credit_consumed': 'مصرف اعتبار رزرو',
  'commercial.credit_returned': 'بازگشت اعتبار رزرو',
  'commercial.credit_purchase_requested': 'درخواست خرید اعتبار رزرو',
};

/** For an action this client has never heard of. The exact code is always printed beside the title. */
export const UNKNOWN_ACTION_LABEL = 'عملیات مدیریتی';

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? UNKNOWN_ACTION_LABEL;
}

export const TARGET_LABELS: Record<string, string> = {
  user: 'کاربر',
  professional: 'متخصص',
  phone_conflict: 'تعارض شماره',
  settlement_batch: 'دسته تسویه',
  search_index: 'نمایه',
  notification_sweep: 'اعلان‌ها',
};

export const UNKNOWN_TARGET_LABEL = 'مورد';

export function targetLabel(targetType: string): string {
  return TARGET_LABELS[targetType] ?? UNKNOWN_TARGET_LABEL;
}

/**
 * The keys of a before/after snapshot. An unlisted key is printed as it is: a
 * snapshot is a bounded flat record of technical field names, and on a forensic
 * screen the exact name is what a reader needs.
 */
export const SNAPSHOT_LABELS: Record<string, string> = {
  roles: 'نقش‌ها',
  role: 'نقش',
  verificationStatus: 'وضعیت احراز',
  requestId: 'شناسه درخواست',
  resolvedAt: 'زمان رفع',
  amountToman: 'مبلغ',
  orderCount: 'تعداد سفارش',
  partyType: 'نوع طرف',
  partyId: 'شناسه طرف',
  method: 'روش',
  reversalId: 'شناسه برگشت',
  indexed: 'تعداد نمایه‌شده',
  projectionRows: 'ردیف پروجکشن',
  attempted: 'تلاش',
  sent: 'ارسال‌شده',
  deadLettered: 'ناموفق نهایی',
};
