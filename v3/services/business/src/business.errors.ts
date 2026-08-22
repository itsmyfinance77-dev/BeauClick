import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@beauclick/http';

export class BusinessAlreadyExistsException extends DomainException {
  constructor() {
    super('BUSINESS_ALREADY_EXISTS', 'شما قبلاً یک کسب‌وکار ثبت کرده‌اید.', HttpStatus.CONFLICT);
  }
}

export class StaffInviteRejectedException extends DomainException {
  constructor(message: string, detail?: unknown) {
    super('STAFF_INVITE_REJECTED', message, HttpStatus.CONFLICT, detail);
  }
}

export class StaffMembershipNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این عضویت یافت نشد.', HttpStatus.NOT_FOUND);
  }
}
