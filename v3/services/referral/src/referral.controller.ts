import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { IsString } from 'class-validator';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import type { ReferralClaimResult, ReferralCodeView } from '@beauclick/referral-contract';

import { ReferralService } from './referral.service';

/**
 * The query string this route accepts: **nothing**.
 *
 * An empty class, and the emptiness is the mechanism rather than a placeholder.
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * and those only apply to a parameter that is actually bound to a DTO — a
 * handler with no `@Query()` at all is never validated, so an unexpected
 * parameter is silently **ignored**.
 *
 * Ignored is not good enough here. Issue #11 requires a forged owner identity to
 * be *rejected*, and the difference is real: a silently-ignored `?ownerId=` is a
 * field somebody later wires up by accident, and until they do it trains callers
 * to believe the server read it. With this DTO bound, every query parameter is
 * non-whitelisted and the request is refused with a 400.
 *
 * The cost is that a legitimate future parameter has to be added here
 * deliberately, which is the point.
 */
export class ReferralCodeQueryDto {}

/**
 * The claim request body: **one field, and nothing else may be sent.**
 *
 * ## Every forged identity field is REFUSED, not ignored
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here — `refereeUserId`, `referrerUserId`,
 * `ownerUserId`, `userId`, `phone`, `createdAt`, `accountAge`,
 * `hasCompletedBooking`, `rewardAmount`, `expiresAt`, `status` — produces a
 * **400** rather than being silently dropped.
 *
 * Issue #27 requires exactly that, and the difference is real rather than
 * pedantic: a silently-ignored `refereeUserId` is a field somebody later wires
 * up by accident, and until they do it trains callers to believe the server read
 * it. A 400 says the field does not exist, which is true. `ReferralCodeQueryDto`
 * above makes the same choice for the read route's query string, and its
 * docblock records that the route's behaviour was the weaker one until the
 * real-PostgreSQL suite asserted otherwise and failed.
 *
 * ## Why the code's SHAPE is deliberately NOT validated here
 *
 * `@IsString()` and nothing more. The obvious version of this class carried
 * `@Matches(/^[ALPHABET]{10}$/)` so a malformed code was refused at the edge,
 * and it had to be removed — the adversarial suite caught it leaking a bearer
 * credential.
 *
 * The platform's `ValidationException` serialises class-validator's
 * `ValidationError`, and that object carries `target` and `value` — **the
 * submitted payload**. So a failed `@Matches` returned
 * `{"target":{"code":"…"},"value":"…"}`, putting whatever the caller typed into
 * a response body and from there into whatever logs client errors. A custom
 * `message` does not help: the echo is the pipe's, not the constraint's.
 *
 * For most routes that is harmless, because the caller is being shown their own
 * input. Here the input is a **bearer credential**, and `V32-DEC-033` keeps a
 * referral code out of exception messages specifically. The realistic trigger is
 * not an attacker: it is a customer typing their inviter's real code in
 * lowercase — malformed, because `isReferralCodeShape` is deliberately
 * case-sensitive, and one `toUpperCase()` away from the live credential.
 *
 * So the shape check moved into the service, where a malformed code becomes the
 * ordinary collapsed refusal with no `details` at all. Three consequences, all
 * of them improvements:
 *
 *  * **Nothing is echoed.** The refusal carries no payload to echo into.
 *  * **Indistinguishability gets stronger, not weaker.** A malformed code and an
 *    unknown code now return the identical 409 — one fewer distinction the route
 *    can make.
 *  * **A malformed probe consumes a throttle attempt**, as it should: it was an
 *    attempt. The edge check would have let an attacker probe for free.
 *
 * The cost is that a genuinely mistyped code costs the customer one of their ten
 * hourly attempts. That is the correct trade against leaking the credential, and
 * a page can still refuse obvious garbage locally without a request —
 * `isReferralCodeShape` is exported from the contract precisely so it can.
 *
 * `@IsString()` stays, because a non-string is not a code and cannot leak one;
 * the body-size limit bounds the rest.
 */
export class ReferralClaimDto {
  @IsString()
  code!: string;
}

/**
 * The caller's own referral identity.
 *
 * ## The rule this route follows
 *
 * **It accepts no input at all.** No body, no query parameter, no path segment,
 * no header. There is nothing to forge, because there is nothing to send: the
 * subject is `@CurrentUser().userId` from the verified JWT, and the mount point
 * is `v1/me/referral` rather than `v1/referral/:userId` so there is no segment
 * that could ever be mistaken for one.
 *
 * A forged `?ownerId=` is **refused with a 400** rather than ignored, and that
 * takes a deliberate act: `ReferralCodeQueryDto` below is an empty class bound
 * to `@Query()` purely so the global `ValidationPipe` runs at all. Without it
 * the pipe never sees the query string and an unexpected parameter is silently
 * dropped — which was this route's behaviour until the real-PostgreSQL suite
 * asserted otherwise and failed.
 *
 * ## No capability, and that is a decision
 *
 * `journey`'s `/v1/me/journey`, the customer half of `/v1/me/loyalty`, and
 * `/v1/me/wishlist` are authenticated-only for the same reason (ADR-035 §10):
 * this surface acts exclusively on the caller's own data and gates no privileged
 * action. `ai` requires `bc_use_ai_assistant` because its surface has real cost
 * and safety consequences; reading one's own referral code has neither.
 *
 * ## Why there is no refusal to make indistinguishable
 *
 * Every other module in this codebase has a `NotFoundOrNotYoursException`
 * somewhere. This controller has none, and its absence is the security property
 * rather than a gap: there is **no route here that can address another party's
 * code**, so the question a refusal would have to answer indistinguishably
 * cannot be asked. Story #27's claim route is where a code is looked up by
 * value, and `V32-DEC-019` already binds it to one indistinguishable response.
 */
@Controller('v1/me/referral')
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  /**
   * The caller's code, created on first read.
   *
   * **A `GET` that can write, which is worth naming rather than glossing.** It
   * is what issue #11 requires, and what makes it defensible is that the write
   * is idempotent in the strong sense: the first call and the thousandth return
   * the same body, and nothing observable changes in between. A prefetch or a
   * double-mount costs one row, once.
   *
   * Returns 200 whether the code was just minted or already existed — never
   * 201-vs-200 as a signal, because that difference would tell a caller
   * something about state they can already read, and would make the response
   * depend on history rather than on facts.
   */
  @Get('code')
  async code(
    // Bound solely so the ValidationPipe runs and refuses any query parameter.
    // The value is never read -- there is nothing in it to read.
    @Query() _query: ReferralCodeQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReferralCodeView> {
    return this.referral.codeFor(user.userId);
  }

  /**
   * Claims an invitation — V3.2-C Story #27 (ADR-036 §1).
   *
   * **The referee is `user.userId` from the verified JWT and comes from
   * nowhere else.** The code in the body is the only client-controlled claim
   * credential in the story; the referrer is resolved server-side from that
   * code's row and is never sent by anybody.
   *
   * Mounted under `v1/me/referral` alongside the read route, for the reason
   * ADR-035 §10 records: there is no path segment that could be mistaken for a
   * subject id, because there is no path segment at all.
   *
   * ## Why 200 rather than 201
   *
   * A `POST` that creates a row is conventionally 201, and this one deliberately
   * is not — for the same reason the read route above returns 200 whether it
   * minted or found: **a status difference is a signal**, and every signal on
   * this surface has to justify itself. There is also no `Location` to give,
   * because the created row is not addressable: no route reads an attribution by
   * id, and adding one would be adding the oracle this route exists to avoid.
   *
   * ## The three answers this route can give
   *
   * | Status | Meaning |
   * |---|---|
   * | **200** | Attributed. The body carries the caller's own two facts and nothing about the referrer. |
   * | **409** | Refused — **byte-identical** for all six eligibility cases (`V32-DEC-019`). |
   * | **429** | The caller's own hourly attempt limit is spent (ADR-036 §6c). |
   *
   * Plus **400** for a malformed or forged body, from the DTO above, and **401**
   * when unauthenticated — which is the guard's answer, reached before this
   * handler and before any attempt is charged.
   *
   * The 409 is neither a code oracle, an account oracle, a booking oracle, nor a
   * code-owner oracle: `ReferralClaimRefusedException` takes no arguments, so
   * there is no per-call-site value that could differ between the six cases.
   *
   * ## No capability, no audit action
   *
   * The route acts on the caller's own attribution and gates no privileged
   * action, so it is authenticated-only — the same reasoning `journey`, the
   * customer half of `loyalty`, and `wishlist` all record. `libs/audit`'s boot
   * check requires an `@AuditAction` only for a mutation gated by a PRIVILEGED
   * capability, and there is none here.
   */
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: ReferralClaimDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReferralClaimResult> {
    // `user.userId` first and `body.code` second, matching the service
    // signature, so the one value a client controls can never land in the
    // parameter that decides WHO is being attributed.
    return this.referral.claim(user.userId, body.code);
  }
}
