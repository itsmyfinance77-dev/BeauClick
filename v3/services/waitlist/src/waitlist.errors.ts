import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@beauclick/http';

export class AlreadyOnWaitlistException extends DomainException {
  constructor() {
    super('ALREADY_ON_WAITLIST', 'شما قبلاً در این لیست انتظار ثبت‌نام کرده‌اید.', HttpStatus.CONFLICT);
  }
}

export class OfferNotAvailableException extends DomainException {
  constructor() {
    super('OFFER_NOT_AVAILABLE', 'این پیشنهاد دیگر در دسترس نیست.', HttpStatus.CONFLICT);
  }
}

export class WaitlistEntryNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}
