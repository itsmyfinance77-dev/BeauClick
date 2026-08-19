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
  constructor() {
    super('RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class UnauthorizedDomainException extends DomainException {
  constructor() {
    super('UNAUTHORIZED', 'برای این عملیات باید وارد حساب کاربری خود شوید.', HttpStatus.UNAUTHORIZED);
  }
}
