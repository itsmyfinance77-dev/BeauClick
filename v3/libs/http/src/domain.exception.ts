import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The base for every intentional, Persian-messaged error a V3 service
 * throws. V3_API_CONTRACT_BLUEPRINT.md §6: error.message is always Persian
 * (server-translated) -- a raw English/internal error must never reach the
 * client, which is exactly what BeauClickExceptionFilter enforces for
 * anything that ISN'T one of these (see that filter).
 */
export class DomainException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export class ValidationException extends DomainException {
  constructor(details?: unknown) {
    super('VALIDATION_ERROR', 'اطلاعات ارسال‌شده نامعتبر است.', HttpStatus.BAD_REQUEST, details);
  }
}

export class RateLimitedException extends DomainException {
  /**
   * `retryAfterSeconds` (`QA-19`) -- how long until the caller may try again,
   * when the limit that fired can answer that question.
   *
   * Optional, and absent means "not known" rather than "zero". A per-hour
   * window's remaining time depends on when each of several earlier requests
   * landed, and reporting a made-up number would be worse than reporting none:
   * a client would count down to a moment that still fails.
   *
   * A resend cooldown CAN answer it exactly, and that is the case the UI needs
   * -- QA-19 exists because the resend button currently fails with an
   * unanticipated 429 instead of counting down.
   */
  constructor(retryAfterSeconds?: number) {
    super(
      'RATE_LIMITED',
      'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
      HttpStatus.TOO_MANY_REQUESTS,
      retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    );
  }
}

export class UnauthorizedDomainException extends DomainException {
  constructor() {
    super('UNAUTHORIZED', 'برای این عملیات باید وارد حساب کاربری خود شوید.', HttpStatus.UNAUTHORIZED);
  }
}
