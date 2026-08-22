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
