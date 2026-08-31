import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ReferralModule } from '@beauclick/referral';

/**
 * The V3.2-C Story #11 composition root.
 *
 * **The smallest composition module in the repository, and the smallness is the
 * point.** It binds no port, merges no outbox source, registers no event
 * handler, and provides no adapter — it exists so `ReferralModule` is
 * instantiated in the application graph, and so the reason it needs nothing else
 * is written down somewhere a reader will look.
 *
 * ## Why there is no port to bind
 *
 * `WishlistCompositionModule` exists because `wishlist` must read `provider` to
 * decide whether a saved target is showable, and ADR-011 forbids the import. A
 * referral code is drawn from a CSPRNG and stored against the session's own user
 * id: **no fact from any other domain participates**, so there is no cross-domain
 * read to write down and no token to bind.
 *
 * Story #27 changes this. Attribution has to ask `identity` how old an account
 * is, and `V32-DEC-019` binds that answer into one indistinguishable refusal —
 * so a port will be declared by `referral` and bound here, exactly as the
 * wishlist's is. Declaring it now would be a seam nothing crosses.
 *
 * ## What is deliberately not composed here
 *
 * **No outbox source, and no `REFERRAL_OUTBOX_SOURCES` token.** `referral` IS in
 * `ServiceName` (ADR-035 §1), which is the opposite of the wishlist's treatment
 * and is worth not confusing: the union membership exists so Story #12 can
 * declare `ReferralQualified` without first editing a closed vocabulary. This
 * story produces no event, has no `referral.outbox_events` table, and therefore
 * contributes nothing for the relay to drain.
 *
 * **No event handler.** The module consumes nothing. A referral code is not a
 * reaction to any domain fact — it is created by its owner reading it.
 *
 * **No notification category and no notification.** `V32-DEC-033` restricts
 * referral notifications to the **qualified** and **reversed** moments, and
 * neither exists in this story. Getting a code is not a lifecycle moment; it is
 * the absence of one.
 *
 * **No sweep scheduler.** There is no retention horizon: a code is destroyed by
 * its owner's erasure and by nothing else (`V32-DEC-019`). A scheduler that swept
 * expired codes would implement an expiry `V32-DEC-033` explicitly refuses.
 *
 * **Nothing from Stories #12, #13, #14, #27, or #28.** No attribution, no claim
 * route, no qualification, no reward grant, no cap counter, no abuse suite, and
 * no frontend.
 */
@Module({
  imports: [ConfigModule, ReferralModule],
  exports: [ReferralModule],
})
export class ReferralCompositionModule {}
