import { Controller, Get } from '@nestjs/common';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import type { ReferralCodeView } from '@beauclick/referral-contract';

import { ReferralService } from './referral.service';

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
 * A forged `?ownerId=` is still **refused with a 400** rather than ignored,
 * because the global `ValidationPipe` runs with `forbidNonWhitelisted` and this
 * handler declares no query DTO to whitelist it into. That is the stronger
 * outcome: a silently-ignored field is one somebody later wires up by accident.
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
  async code(@CurrentUser() user: AuthenticatedUser): Promise<ReferralCodeView> {
    return this.referral.codeFor(user.userId);
  }
}
