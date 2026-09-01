import { Injectable } from '@nestjs/common';
import { toPersianDigits } from '@beauclick/persian-utils';
import { NotificationCategory } from '../entities/notification.entities';
import { RenderedMessage } from '../channels/notification-channel.port';

export interface TemplateDefinition {
  key: string;
  category: NotificationCategory;
  /** Variables the template requires. A missing one is a render failure, not a blank in the message. */
  requiredVars: string[];
  subject: string;
  body: string;
  short: string;
  /** Where tapping the notification should land. `{var}` placeholders are substituted. */
  deepLink: string | null;
}

/**
 * The template catalogue.
 *
 * Two rules, both learned from real failure modes:
 *
 * **A missing variable is a render FAILURE, not a blank.** V2 substituted
 * whatever was present and left unmatched placeholders in the output, so a
 * customer could receive a literal "رزرو شما در {date} تأیید شد". Rendering
 * throws here instead, which fails the notification loudly at request time
 * rather than delivering nonsense.
 *
 * **Numbers render in Persian digits.** Every user-facing number on this
 * platform does, and a notification is no exception -- a Persian sentence
 * with ASCII digits reads as broken. Applied centrally at render time so no
 * individual template author has to remember.
 */
const TEMPLATES: TemplateDefinition[] = [
  {
    /**
     * V3.2-B. A new chat message.
     *
     * **Carries no message body and no sender name**, and `requiredVars` is
     * empty so there is nothing a caller could pass one through. ADR-032 §1
     * keeps prose out of notification payloads, and a preview would put the
     * message into a channel the retention and erasure rules do not cover.
     *
     * The deep link is the inbox rather than the thread: a notification that
     * named the conversation in its URL would leak which conversation it was
     * about into browser history and any referrer.
     */
    key: 'chat_message_received',
    category: 'chat',
    requiredVars: [],
    subject: 'پیام جدید',
    body: 'پیام جدیدی دریافت کرده‌اید.',
    short: 'پیام جدیدی دریافت کرده‌اید.',
    deepLink: '/chat',
  },
  {
    /**
     * V3.2-C Story #12. Somebody the customer invited completed their first
     * booking (`V32-DEC-033`, ADR-037 §11).
     *
     * **`requiredVars` is empty, and that is the mechanism rather than a
     * coincidence.** `V32-DEC-033` keeps referral codes, phone numbers, display
     * names, and free prose out of every notification payload — and a referral
     * code is a bearer credential that never leaves the authenticated read
     * route. With no declared variable there is nothing a caller could pass one
     * through, exactly as `chat_message_received` above.
     *
     * **It names no points figure**, and that is correctness rather than
     * restraint: `V32-DEC-016` sets both reward values to **0**, so a message
     * claiming anything was earned would be false. It states the lifecycle
     * fact, which is true whatever the configured economics are — and stays
     * true on the day the business sets a real number, so this copy does not
     * become a lie in either direction.
     *
     * **It does not name the person who was invited.** A referrer's export may
     * not reveal referee identity (`V32-DEC-019`), and a notification is a
     * weaker container than an export, not a stronger one.
     *
     * The deep link is the customer's own referral page rather than anything
     * naming the referral, for the reason the chat template records: an id in a
     * URL leaks into browser history and any referrer header.
     */
    key: 'referral_qualified_referrer',
    category: 'referral',
    requiredVars: [],
    subject: 'دعوت شما به نتیجه رسید',
    body: 'یکی از دعوت‌های شما تکمیل شد.',
    short: 'یکی از دعوت‌های شما تکمیل شد.',
    deepLink: '/referral',
  },
  {
    /**
     * V3.2-C Story #12. The invited customer's own referral qualified.
     *
     * The mirror of the template above and subject to the same rules: no
     * variables, no points figure, and **no reference to the inviter**. A
     * referee's export may never carry the referrer's bearer code, phone, or
     * display name (`V32-DEC-019`); the same boundary applies here, and it is
     * kept by the template having no slot for any of them.
     */
    key: 'referral_qualified_referee',
    category: 'referral',
    requiredVars: [],
    subject: 'دعوت شما ثبت شد',
    body: 'دعوتی که با آن ثبت‌نام کردید تکمیل شد.',
    short: 'دعوتی که با آن ثبت‌نام کردید تکمیل شد.',
    deepLink: '/referral',
  },
  {
    key: 'booking_confirmed',
    category: 'booking',
    requiredVars: ['professionalName', 'date', 'time'],
    subject: 'رزرو شما تأیید شد',
    body: 'رزرو شما نزد {professionalName} برای {date} ساعت {time} تأیید شد.',
    short: 'رزرو شما نزد {professionalName} برای {date} ساعت {time} تأیید شد.',
    deepLink: '/bookings',
  },
  {
    key: 'booking_cancelled',
    category: 'booking',
    requiredVars: ['professionalName', 'date'],
    subject: 'رزرو شما لغو شد',
    body: 'رزرو شما نزد {professionalName} برای {date} لغو شد.',
    short: 'رزرو شما نزد {professionalName} برای {date} لغو شد.',
    deepLink: '/bookings',
  },
  {
    key: 'booking_rescheduled',
    category: 'booking',
    requiredVars: ['professionalName', 'date', 'time'],
    subject: 'زمان رزرو شما تغییر کرد',
    body: 'رزرو شما نزد {professionalName} به {date} ساعت {time} منتقل شد.',
    short: 'رزرو شما به {date} ساعت {time} منتقل شد.',
    deepLink: '/bookings',
  },
  {
    key: 'payment_succeeded',
    category: 'payment',
    requiredVars: ['amountToman'],
    subject: 'پرداخت شما با موفقیت انجام شد',
    body: 'پرداخت {amountToman} تومان با موفقیت انجام شد. رسید در حساب کاربری شما ثبت شده است.',
    short: 'پرداخت {amountToman} تومان انجام شد.',
    deepLink: '/bookings',
  },
  {
    key: 'loyalty_tier_changed',
    category: 'loyalty',
    requiredVars: ['tierName'],
    subject: 'سطح باشگاه مشتریان شما تغییر کرد',
    body: 'تبریک! شما به سطح {tierName} رسیدید.',
    short: 'شما به سطح {tierName} رسیدید.',
    deepLink: '/loyalty',
  },
  {
    key: 'membership_activated',
    category: 'loyalty',
    requiredVars: ['planName'],
    subject: 'عضویت شما فعال شد',
    body: 'عضویت {planName} برای شما فعال شد.',
    short: 'عضویت {planName} فعال شد.',
    deepLink: '/loyalty',
  },
  {
    key: 'waitlist_offered',
    category: 'waitlist',
    requiredVars: ['professionalName', 'expiresAtTime'],
    subject: 'یک نوبت برای شما آزاد شد',
    body: 'نوبتی نزد {professionalName} آزاد شد و به شما پیشنهاد شده است. تا ساعت {expiresAtTime} فرصت دارید آن را بپذیرید.',
    short: 'نوبتی نزد {professionalName} به شما پیشنهاد شد -- تا {expiresAtTime} فرصت دارید.',
    deepLink: '/waitlist',
  },
  {
    key: 'privacy_export_requested',
    category: 'privacy',
    requiredVars: [],
    subject: 'درخواست دریافت اطلاعات شما ثبت شد',
    body: 'درخواست شما برای دریافت اطلاعات ثبت شد. پس از آماده شدن، از همین بخش می‌توانید آن را دانلود کنید.',
    short: 'درخواست دریافت اطلاعات شما ثبت شد.',
    deepLink: '/privacy',
  },
  {
    key: 'privacy_export_ready',
    category: 'privacy',
    requiredVars: ['expiresAtDate'],
    subject: 'اطلاعات شما آماده دانلود است',
    body: 'فایل اطلاعات شما آماده است و تا {expiresAtDate} قابل دانلود خواهد بود.',
    short: 'اطلاعات شما تا {expiresAtDate} قابل دانلود است.',
    deepLink: '/privacy',
  },
  {
    // The one message the grace window depends on. If this does not arrive,
    // GAP-21's whole purpose -- a way back from an accidental deletion --
    // never reaches the person who needs it. Hence the mandatory category.
    key: 'privacy_erasure_requested',
    category: 'privacy',
    requiredVars: ['executeAfterDate'],
    subject: 'درخواست حذف حساب شما ثبت شد',
    body: 'درخواست حذف حساب شما ثبت شد و در {executeAfterDate} اجرا می‌شود. تا آن زمان می‌توانید آن را لغو کنید.',
    short: 'حساب شما در {executeAfterDate} حذف می‌شود. تا آن زمان امکان لغو دارید.',
    deepLink: '/privacy',
  },
  {
    key: 'privacy_erasure_cancelled',
    category: 'privacy',
    requiredVars: [],
    subject: 'درخواست حذف حساب شما لغو شد',
    body: 'درخواست حذف حساب شما لغو شد و حساب شما فعال باقی می‌ماند.',
    short: 'درخواست حذف حساب شما لغو شد.',
    deepLink: '/privacy',
  },
  {
    key: 'settlement_recorded',
    category: 'payment',
    requiredVars: ['amountToman'],
    subject: 'تسویه حساب شما ثبت شد',
    body: 'مبلغ {amountToman} تومان برای شما تسویه و ثبت شد.',
    short: 'مبلغ {amountToman} تومان تسویه شد.',
    deepLink: '/dashboard',
  },
];

export class UnknownTemplateError extends Error {
  constructor(key: string) {
    super(`No notification template registered for key "${key}".`);
  }
}

export class MissingTemplateVariableError extends Error {
  constructor(key: string, missing: string[]) {
    super(`Template "${key}" requires variable(s) ${missing.join(', ')}, which were not supplied.`);
  }
}

@Injectable()
export class TemplateRegistry {
  private readonly byKey = new Map(TEMPLATES.map((t) => [t.key, t]));

  get(key: string): TemplateDefinition {
    const template = this.byKey.get(key);
    if (!template) throw new UnknownTemplateError(key);
    return template;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  categoryOf(key: string): NotificationCategory {
    return this.get(key).category;
  }

  /** Deep link for a template, with its own variables substituted. */
  deepLinkFor(key: string, vars: Record<string, string | number>): string | null {
    const template = this.get(key);
    if (!template.deepLink) return null;
    return this.substitute(template.deepLink, vars, template.key, false);
  }

  render(key: string, vars: Record<string, string | number>): RenderedMessage {
    const template = this.get(key);

    const missing = template.requiredVars.filter(
      (v) => vars[v] === undefined || vars[v] === null || vars[v] === '',
    );
    if (missing.length > 0) throw new MissingTemplateVariableError(key, missing);

    return {
      subject: this.substitute(template.subject, vars, key),
      body: this.substitute(template.body, vars, key),
      short: this.substitute(template.short, vars, key),
    };
  }

  private substitute(
    text: string,
    vars: Record<string, string | number>,
    key: string,
    persianDigits = true,
  ): string {
    return text.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = vars[name];
      if (value === undefined || value === null) {
        // An unmatched placeholder reaching a customer is worse than a
        // failed notification: it looks like the product is broken and it
        // leaks the internal variable name.
        throw new MissingTemplateVariableError(key, [name]);
      }
      const rendered = String(value);
      return persianDigits ? toPersianDigits(rendered) : rendered;
    });
  }
}
