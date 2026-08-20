import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@beauclick/http';

/**
 * Every booking failure a caller can legitimately act on, as a distinct
 * type with a distinct Persian message and HTTP status.
 *
 * Deliberately NOT one generic "booking failed": V2's controller already
 * had to map a three-way `array|null|false` return into 409 vs 429, and the
 * reschedule path returned eight different string codes. Modelling those as
 * real exception types removes the stringly-typed mapping layer entirely,
 * and makes it impossible to add a new failure mode without also giving it
 * a user-facing message.
 */
export class SlotUnavailableException extends DomainException {
  constructor() {
    super('SLOT_UNAVAILABLE', 'این زمان دیگر در دسترس نیست. لطفاً زمان دیگری انتخاب کنید.', HttpStatus.CONFLICT);
  }
}

export class TooManyActiveHoldsException extends DomainException {
  constructor(limit: number) {
    super(
      'TOO_MANY_ACTIVE_HOLDS',
      `شما هم‌زمان بیش از ${limit} رزرو در انتظار پرداخت دارید. ابتدا یکی از آن‌ها را تکمیل یا لغو کنید.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class InvalidBookingTransitionException extends DomainException {
  constructor(from: string, to: string) {
    super(
      'INVALID_BOOKING_TRANSITION',
      'وضعیت این رزرو اجازه‌ی این عملیات را نمی‌دهد.',
      HttpStatus.CONFLICT,
      { from, to },
    );
  }
}

export class RescheduleNotAllowedException extends DomainException {
  constructor(reason: 'status' | 'max_reached' | 'too_close' | 'same_slot' | 'invalid_slot') {
    super('RESCHEDULE_NOT_ALLOWED', RESCHEDULE_MESSAGES[reason], HttpStatus.CONFLICT, { reason });
  }
}

const RESCHEDULE_MESSAGES: Record<string, string> = {
  status: 'این رزرو در وضعیتی نیست که بتوان زمان آن را تغییر داد.',
  max_reached: 'تعداد مجاز تغییر زمان برای این رزرو به پایان رسیده است.',
  too_close: 'تا زمان نوبت فاصله‌ی کافی برای تغییر زمان باقی نمانده است.',
  same_slot: 'زمان انتخابی همان زمان فعلی رزرو است.',
  invalid_slot: 'زمان انتخابی برای این رزرو معتبر نیست.',
};

export class InvalidSlotRangeException extends DomainException {
  constructor(detail: string) {
    super('INVALID_SLOT_RANGE', 'بازه‌ی زمانی انتخاب‌شده معتبر نیست.', HttpStatus.BAD_REQUEST, { detail });
  }
}

export class SlotInPastException extends DomainException {
  constructor() {
    super('SLOT_IN_PAST', 'نمی‌توان برای زمان گذشته نوبت تعریف کرد.', HttpStatus.BAD_REQUEST);
  }
}

export class SlotOverlapsException extends DomainException {
  constructor() {
    super('SLOT_OVERLAPS', 'این بازه با یکی از زمان‌های موجود شما هم‌پوشانی دارد.', HttpStatus.CONFLICT);
  }
}

export class SlotNotReleasableException extends DomainException {
  constructor() {
    super(
      'SLOT_NOT_RELEASABLE',
      'این زمان به یک رزرو فعال اختصاص دارد و باید از مسیر لغو رزرو آزاد شود.',
      HttpStatus.CONFLICT,
    );
  }
}
