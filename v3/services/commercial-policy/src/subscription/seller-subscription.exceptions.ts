import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';

/**
 * The subscription foundation's refusals.
 *
 * ## Why a story with no routes defines HTTP-shaped exceptions
 *
 * Story #56a ships no controller — that is #69. These are `DomainException`s
 * anyway, and not plain `Error`s, for one reason: #69 must not have to invent a
 * refusal vocabulary for failures this story's service already knows how to
 * produce. A domain that throws untyped errors forces the route layer to
 * classify them by message, which is how a "not configured" becomes a 500.
 *
 * ## The disclosure line
 *
 * Different from the catalogue's, because the audience is different. An
 * administrator may read the whole catalogue, so specific refusals disclose
 * nothing. A SELLER may read only their own subscription, so the line here is
 * drawn tighter:
 *
 *  * `SUBSCRIPTION_SELLER_NOT_ELIGIBLE` covers "you own no party", "your party
 *    is deleted" and "that party is not yours" with ONE code and one message.
 *    Distinguishing them would let a caller probe which parties exist and which
 *    are theirs — an enumeration oracle assembled from honest error messages;
 *  * `SUBSCRIPTION_PLAN_NOT_SELECTABLE` likewise covers "no such version",
 *    "draft", "retired" and "outside its activation window" together.
 *
 * `PAID_ACTIVATION_UNAVAILABLE` is deliberately NOT folded into that: it
 * discloses a platform-wide fact (paid plans cannot be activated yet) that is
 * true for everyone and reveals nothing about any particular seller or version.
 * Hiding it would leave a seller unable to tell a permanent refusal from a
 * transient one.
 *
 * Messages are Persian, as `V3_API_CONTRACT_BLUEPRINT.md` §6 requires of every
 * intentional error.
 */

/**
 * The caller owns no eligible party, or the party named is not theirs.
 *
 * One code for three conditions. See the class docblock: the alternative is an
 * oracle.
 */
export class SubscriptionSellerNotEligibleException extends DomainException {
  constructor() {
    super(
      'SUBSCRIPTION_SELLER_NOT_ELIGIBLE',
      'برای این عملیات، فروشنده فعالی به حساب شما متصل نیست.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * The version cannot be subscribed to: it does not exist, is a draft, is
 * retired, or is outside its activation window.
 */
export class SubscriptionPlanNotSelectableException extends DomainException {
  constructor() {
    super(
      'SUBSCRIPTION_PLAN_NOT_SELECTABLE',
      'این نسخه از طرح قابل انتخاب نیست.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * The version has a price above zero.
 *
 * `V33-DEC-018`: only zero-price versions may activate while #46 and #47 are
 * open, and a non-zero selection is refused OUTRIGHT — no pending intent, no
 * dormant paid subscription, no partial activation. This is that refusal, and
 * it is a distinct code so a caller cannot mistake it for a validation error
 * and retry: there is nothing to retry until a visible migration removes the
 * database constraint behind it.
 */
export class SubscriptionPaidActivationUnavailableException extends DomainException {
  constructor() {
    super(
      'SUBSCRIPTION_PAID_ACTIVATION_UNAVAILABLE',
      'در حال حاضر فعال‌سازی طرح‌های غیررایگان امکان‌پذیر نیست.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Another transaction changed the active subscription first.
 *
 * Raised when the compare-and-swap matched no row, which is the ONLY way two
 * concurrent changes can both be honest: one wins, and the loser is told rather
 * than silently overwriting a colleague's transition instant and actor.
 */
export class SubscriptionChangedConcurrentlyException extends DomainException {
  constructor() {
    super(
      'SUBSCRIPTION_CHANGED_CONCURRENTLY',
      'اشتراک این فروشنده هم‌زمان تغییر کرده است. دوباره تلاش کنید.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * No automatically assignable published plan version is active at this instant.
 *
 * `V33-DEC-018` and ADR-041 §6: there is deliberately no fallback. A platform
 * with no base workspace configured refuses rather than inventing entitlements,
 * because an invented one is exactly the implicit fallback this family exists
 * to delete.
 *
 * A `503`, not a `409`: the caller did nothing wrong and the platform is
 * misconfigured.
 */
export class SubscriptionNotConfiguredException extends DomainException {
  constructor(detail: string) {
    super(
      'SUBSCRIPTION_NOT_CONFIGURED',
      'هیچ طرح پایه فعالی پیکربندی نشده است.',
      HttpStatus.SERVICE_UNAVAILABLE,
      { detail },
    );
  }
}
