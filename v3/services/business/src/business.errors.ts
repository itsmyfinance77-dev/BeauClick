import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@beauclick/http';

export class BusinessAlreadyExistsException extends DomainException {
  constructor() {
    super('BUSINESS_ALREADY_EXISTS', 'شما قبلاً یک کسب‌وکار ثبت کرده‌اید.', HttpStatus.CONFLICT);
  }
}

/*
 * `StaffInviteRejectedException` was deleted by V3.3 Story #109 (`#44c`).
 *
 * It carried two DISTINCT `409`s — "you cannot invite yourself" and "this user is
 * already a member or invited", the latter with the violated constraint name in
 * its detail. Each was an enumeration oracle: an owner could submit an identity
 * and read back whether it existed, whether it was already affiliated, and which
 * index said so. `V33-DEC-033` R3/R4 replace all of it with one uniform
 * `202 {}`, so there is nothing left for this exception to express.
 */

export class StaffMembershipNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این عضویت یافت نشد.', HttpStatus.NOT_FOUND);
  }
}
