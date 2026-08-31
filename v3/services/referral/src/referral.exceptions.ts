import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import { REFERRAL_CLAIM_ATTEMPTS_PER_HOUR, REFERRAL_CLAIM_REFUSED_CODE } from '@beauclick/referral-contract';

/**
 * The claim route's refusals (`V32-DEC-019`, ADR-036 §8).
 *
 * There are **two classes in this file and they answer different questions**,
 * which is the whole design:
 *
 *  * `ReferralClaimRefusedException` answers *may this caller claim this code?*
 *    — and answers it identically for every reason it could be no.
 *  * `ReferralClaimThrottledException` answers *has this caller made too many
 *    requests?* — which is a fact about the caller's own behaviour and reveals
 *    nothing about any code, account, booking, or owner.
 *
 * Story #11's `ReferralController` has no refusal at all, and ADR-035 §10
 * records why: no route there can address another party's code, so the question
 * a refusal would have to answer indistinguishably cannot be asked. Here it can
 * be asked, by anybody, ten times an hour.
 */

/**
 * The ONE refusal, for every rejected claim.
 *
 * `V32-DEC-019`: *every refusal on the claim route — unknown code, revoked code,
 * the caller's own code, already attributed, account too old, already booked —
 * returns one indistinguishable response, so the route is neither a code oracle
 * nor an account oracle.*
 *
 * ## The constructor takes NO ARGUMENTS, and that is the mechanism
 *
 * Not a convention, and not a reviewer's discipline. Compare `ChatRefusalException`,
 * which takes a reason, a message, a status, and an `extra` bag — appropriate
 * there, because a chat refusal is *meant* to be actionable and a blocked
 * conversation needs different UI from a closed send window.
 *
 * Here every one of those parameters would be a channel. A `reason` would be the
 * oracle outright; a `status` would let one branch return 404 while another
 * returned 409; an `extra` bag would carry `{ codeExists: false }` the first
 * time somebody debugged a support ticket. A constructor with **no parameters**
 * cannot express a difference between the six cases, so there is no per-call-site
 * decision to get wrong and nothing for a future edit to thread through.
 *
 * The suite compares **complete response bodies** across all six cases with
 * `toEqual`, not status codes — because a status-code assertion passes while a
 * `details.reason` leaks the branch, which is the failure this shape exists to
 * make impossible rather than merely unlikely.
 *
 * ## What it does not carry
 *
 * No referrer identity, phone, display name, or user id. No referral code —
 * not the one that was claimed and not any other, because `V32-DEC-033` keeps a
 * code out of every exception message and the way to keep it out is not to pass
 * it. No internal rejection cause. No `retryAfter`, which would differ between
 * a throttled and an ineligible caller. No `details` at all: `DomainException`
 * makes the field optional and it is left `undefined`, so the serialised body
 * has no key rather than an empty object.
 *
 * ## Why 409 rather than 404, 403, or 422
 *
 * **404 would be the oracle.** "Not found" is an answer about the *code*, and a
 * route that returned it for an unknown code and something else for an
 * ineligible caller would be a code-existence lookup with extra steps — which is
 * exactly what `V32-DEC-019` forbids.
 *
 * **403 would be an answer about the caller**, and would read as an
 * authorization outcome. It is not one: the caller is fully authorized to call
 * this route, and the platform's authorization refusals are a different thing
 * with different handling.
 *
 * **409 says the request conflicts with the current state** without saying whose
 * state or how, which is the honest description of all six cases at once: an
 * already-attributed caller, an expired window, a completed booking, and a code
 * that does not exist are all "the world is not in a shape where this can
 * happen". It is also the status `chat` already uses for its own
 * state-conflict refusals.
 *
 * The message is one fixed Persian sentence, identical for all six, naming no
 * cause and no party.
 */
export class ReferralClaimRefusedException extends DomainException {
  constructor() {
    super(
      REFERRAL_CLAIM_REFUSED_CODE,
      'این کد دعوت برای حساب شما قابل استفاده نیست.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The claim throttle is spent (`V32-DEC-019`, ADR-036 §6c).
 *
 * ## Why this is NOT folded into the refusal above
 *
 * The question was asked deliberately rather than settled by habit, because
 * "collapse everything" is the instinct the rest of this file follows.
 *
 * `V32-DEC-019` enumerates exactly six cases to collapse, and Issue #27's
 * acceptance criteria repeat the same six. **Throttle exhaustion is in neither
 * list**, and it is categorically different from all six: those are facts about
 * *other people's codes* and *the caller's own eligibility*, and a distinct
 * answer to any of them turns the route into a lookup function. Exhaustion is a
 * fact about *how many requests the caller just made* — which the caller already
 * knows, having made them.
 *
 * The stronger reading is also the wrong one. Collapsing exhaustion into the
 * standard refusal would tell an attacker who had spent their ten guesses that
 * all ten were **wrong**, since a refusal is what a wrong guess returns. A 429
 * says nothing about the guesses at all, so the distinct status is the *more*
 * private answer rather than a concession.
 *
 * ## What it carries, and what it does not
 *
 * It carries `attemptsPerHour`, which is `REFERRAL_CLAIM_ATTEMPTS_PER_HOUR` —
 * the same constant the browser contract exports, so telling the caller is
 * disclosing a published limit rather than leaking state.
 *
 * It carries **no `retryAfterSeconds`**, and `RateLimitedException`'s own
 * docblock explains why that is the honest choice for this window shape: a
 * per-hour limit's remaining time depends on when each of several earlier
 * requests landed, and reporting a made-up number would be worse than reporting
 * none — a client would count down to a moment that still fails. The bucket's
 * boundary would technically answer it, and deliberately is not returned: it
 * would disclose *when within the hour* the caller's first attempt landed, which
 * is behavioural data the caller does not need back.
 *
 * It carries no count of attempts made and no count remaining. Either would let
 * a caller measure the counter's state, and the remaining count would turn every
 * successful claim into a probe of whether the previous request consumed a slot.
 */
export class ReferralClaimThrottledException extends DomainException {
  constructor() {
    super(
      'REFERRAL_CLAIM_THROTTLED',
      'تعداد تلاش‌های شما برای ثبت کد دعوت بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
      HttpStatus.TOO_MANY_REQUESTS,
      { attemptsPerHour: REFERRAL_CLAIM_ATTEMPTS_PER_HOUR },
    );
  }
}
