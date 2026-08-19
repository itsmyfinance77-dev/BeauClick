import { NotFoundException } from '@nestjs/common';

/**
 * V3_SECURITY_MODEL.md §3: "a resource that doesn't exist and a resource
 * that exists but isn't yours should return the same generic response --
 * never let an error message allow enumeration of which resource IDs are
 * valid." One exception type, one message, used for both cases everywhere
 * in this codebase -- never a bespoke 403 that would let a caller tell the
 * two apart.
 */
export class NotFoundOrNotYoursException extends NotFoundException {
  constructor() {
    super({
      code: 'NOT_FOUND_OR_NOT_YOURS',
      message: 'این مورد یافت نشد.',
    });
  }
}
