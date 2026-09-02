import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import type { AiRefusalReason } from '@beauclick/ai-contract';

/**
 * Every refusal this module produces, and the one rule they all follow.
 *
 * **The `reason` is from the closed browser-safe vocabulary, and the message is
 * Persian.** Nothing else travels: no provider name, no model name, no
 * configuration value, no internal state name, no exception text, and no
 * counterpart's data. `@beauclick/ai-contract` owns the vocabulary so the page
 * and the server cannot disagree about which reasons exist, and a reason the
 * server can emit that the page has no branch for is prevented by construction
 * rather than by review.
 *
 * `details.reason` rather than reusing `code`: `code` is the platform-wide
 * error code every V3 domain emits and the exception filter renders, and
 * overloading it with an AI-specific vocabulary would make one field mean two
 * things. The page reads `details.reason`.
 */
export class AiRefusalException extends DomainException {
  constructor(reason: AiRefusalReason, message: string, status: HttpStatus, extra?: Record<string, unknown>) {
    super('AI_REFUSED', message, status, { reason, ...(extra ?? {}) });
  }
}

export class AiConsentRequiredException extends AiRefusalException {
  constructor() {
    super(
      'consent_required',
      'برای استفاده از دستیار هوشمند، ابتدا باید شرایط استفاده را بپذیرید.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * The daily allowance is spent.
 *
 * Carries the exact reset INSTANT, not a duration. A duration computed
 * server-side is stale by the time it renders, and a client counting down to a
 * moment it calculated in its own timezone counts down to the wrong one — the
 * same reasoning `RateLimitedException.retryAfterSeconds` records for the case
 * where an exact answer IS available. Here it always is: the Tehran calendar
 * boundary is a fact, not an estimate.
 */
export class AiQuotaExhaustedException extends AiRefusalException {
  constructor(limit: number, resetsAt: Date) {
    super(
      'quota_exhausted',
      'سقف پیام‌های امروز شما با دستیار هوشمند تکمیل شده است. از نیمه‌شب دوباره می‌توانید پیام بفرستید.',
      HttpStatus.TOO_MANY_REQUESTS,
      { limit, used: limit, remaining: 0, resetsAt: resetsAt.toISOString() },
    );
  }
}

/**
 * The message was screened out before any provider was invoked.
 *
 * ONE reason for both an injection attempt and a request for somebody else's
 * private data. Distinguishing them would tell a prober which of their two
 * techniques was detected, which is telling them how to rephrase. The
 * distinction is kept server-side for an operator's counter and never leaves
 * (ADR-030 T1).
 */
export class AiUnsafeRequestException extends AiRefusalException {
  constructor(message: string) {
    super('unsafe_request', message, HttpStatus.BAD_REQUEST);
  }
}

export class AiMessageTooLongException extends AiRefusalException {
  constructor(maxCharacters: number) {
    super(
      'message_too_long',
      'پیام شما خالی است یا از حد مجاز طولانی‌تر است. لطفاً پرسش خود را کوتاه‌تر بنویسید.',
      HttpStatus.BAD_REQUEST,
      { maxCharacters },
    );
  }
}

export class AiConversationClosedException extends AiRefusalException {
  constructor() {
    super(
      'conversation_closed',
      'این گفتگو بسته شده است و دوباره باز نمی‌شود. برای ادامه، یک گفتگوی جدید شروع کنید.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The retained-conversation cap is reached and cannot be satisfied.
 *
 * Reached only when every one of the customer's conversations is ACTIVE.
 * `V32-DEC-002` is explicit that an active session is never silently evicted,
 * so the platform refuses rather than destroying one — which is the whole
 * reason this refusal exists as a distinct outcome instead of the eviction
 * quietly taking whatever was oldest.
 */
export class AiConversationLimitException extends AiRefusalException {
  constructor(limit: number) {
    super(
      'conversation_limit_reached',
      'به سقف گفتگوهای نگهداری‌شده رسیده‌اید و همه‌ی آن‌ها هنوز باز هستند. لطفاً یکی از گفتگوهای قبلی را حذف کنید.',
      HttpStatus.CONFLICT,
      { limit },
    );
  }
}

/**
 * No provider could answer.
 *
 * Deliberately indistinguishable between "none is configured", "the selected
 * one is unknown", "it timed out", and "it threw". A caller learning which
 * learns something about the deployment's configuration and can do nothing with
 * any of the four answers. The distinction is a log line and a counter.
 *
 * This is also the refusal a provider FAILURE produces — never a silent
 * substitution of the deterministic assistant, which is the `F-03` mistake
 * ADR-029 §3 exists to prevent.
 */
export class AiAssistantUnavailableException extends AiRefusalException {
  constructor() {
    super(
      'assistant_unavailable',
      'دستیار هوشمند در حال حاضر نمی‌تواند پاسخ دهد. لطفاً کمی بعد دوباره تلاش کنید.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * A conversation that is not the caller's, or does not exist.
 *
 * ONE exception for both, and it is the only correct answer. `V3_SECURITY_MODEL.md`
 * §3's rule and the pattern every self-scoped route in this platform already
 * follows: the owner goes into the WHERE clause, and another customer's id
 * resolves to the same 404 as a nonexistent one. Anything else is a membership
 * oracle — a caller enumerating ids could learn which conversations exist
 * without being able to read any of them, which is still a leak.
 *
 * Not an `AiRefusalException`: it carries no browser-safe reason, because there
 * is nothing for a page to branch on. The resource is absent, full stop.
 */
export class AiConversationNotFoundException extends DomainException {
  constructor() {
    super('AI_CONVERSATION_NOT_FOUND', 'گفتگوی موردنظر پیدا نشد.', HttpStatus.NOT_FOUND);
  }
}
