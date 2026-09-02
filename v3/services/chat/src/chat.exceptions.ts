import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import type { ChatRefusalReason } from '@beauclick/chat-contract';

/**
 * Every refusal this module produces.
 *
 * Two rules, and the second is the interesting one.
 *
 * **The reason is from the closed browser-safe vocabulary and the message is
 * Persian.** Nothing else travels: no internal state name, no exception text, no
 * counterpart's data, no booking id, no order id.
 *
 * **Refusals that would reveal something are collapsed.** `not_eligible` covers
 * "no qualifying booking", "that counterparty does not exist", and "you have
 * never transacted with them" as one answer, because distinguishing them would
 * confirm that a professional exists. `blocked` is returned identically to the
 * blocker and the blocked, because `V32-DEC-014` requires that a blocked party is
 * never told who blocked them — and a second reason code would tell them.
 */
export class ChatRefusalException extends DomainException {
  constructor(reason: ChatRefusalReason, message: string, status: HttpStatus, extra?: Record<string, unknown>) {
    super('CHAT_REFUSED', message, status, { reason, ...(extra ?? {}) });
  }
}

/**
 * No qualifying booking relationship.
 *
 * Deliberately the same answer for a counterparty that does not exist, one the
 * caller has never booked, one whose only booking went `pending` → `cancelled`,
 * and one whose booking carries no seller snapshot. A caller enumerating ids
 * learns nothing about which professionals exist.
 */
export class ChatNotEligibleException extends ChatRefusalException {
  constructor() {
    super(
      'not_eligible',
      'برای گفتگو با این ارائه‌دهنده، باید رزرو تأییدشده‌ای با او داشته باشید.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ChatSendWindowClosedException extends ChatRefusalException {
  constructor(windowDays: number, closedAt: Date) {
    super(
      'send_window_closed',
      'مهلت ارسال پیام برای این گفتگو به پایان رسیده است. با ثبت رزرو جدید دوباره می‌توانید پیام بفرستید.',
      HttpStatus.CONFLICT,
      { windowDays, closedAt: closedAt.toISOString() },
    );
  }
}

/**
 * A block exists in one direction or the other.
 *
 * Carries no indication of WHICH direction. The blocker knows because they acted;
 * the blocked party is told only that sending is unavailable.
 */
export class ChatBlockedException extends ChatRefusalException {
  constructor() {
    super('blocked', 'امکان ارسال پیام در این گفتگو وجود ندارد.', HttpStatus.CONFLICT);
  }
}

export class ChatConversationClosedException extends ChatRefusalException {
  constructor() {
    super(
      'conversation_closed',
      'این گفتگو توسط تیم پشتیبانی بسته شده است و امکان ارسال پیام تازه ندارد.',
      HttpStatus.CONFLICT,
    );
  }
}

export class ChatSenderRestrictedException extends ChatRefusalException {
  constructor() {
    super(
      'sender_restricted',
      'امکان ارسال پیام برای حساب شما محدود شده است.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ChatMessageTooLongException extends ChatRefusalException {
  constructor(maxCharacters: number) {
    super(
      'message_too_long',
      'پیام شما خالی است یا از حد مجاز طولانی‌تر است.',
      HttpStatus.BAD_REQUEST,
      { maxCharacters },
    );
  }
}

export class ChatRateLimitedException extends ChatRefusalException {
  constructor(perMinute: number, perDay: number) {
    super(
      'rate_limited',
      'تعداد پیام‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
      HttpStatus.TOO_MANY_REQUESTS,
      { perMinute, perDay },
    );
  }
}

export class ChatReportAlreadyOpenException extends ChatRefusalException {
  constructor() {
    super(
      'report_already_open',
      'گزارش قبلی شما برای این گفتگو هنوز در حال بررسی است.',
      HttpStatus.CONFLICT,
    );
  }
}

export class ChatReportRateLimitedException extends ChatRefusalException {
  constructor(perDay: number) {
    super(
      'report_rate_limited',
      'تعداد گزارش‌های شما در ۲۴ ساعت گذشته بیش از حد مجاز است.',
      HttpStatus.TOO_MANY_REQUESTS,
      { perDay },
    );
  }
}
