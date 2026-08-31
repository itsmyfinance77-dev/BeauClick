import { Controller, Get, Query } from '@nestjs/common';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import type { ReferralCodeView } from '@beauclick/referral-contract';

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
}
