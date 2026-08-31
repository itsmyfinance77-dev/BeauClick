import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookingEntity } from '@beauclick/booking';
import { UserEntity } from '@beauclick/identity';
import { REFERRAL_BOOKING_PORT, REFERRAL_IDENTITY_PORT, ReferralModule } from '@beauclick/referral';

import { ReferralBookingAdapter, ReferralIdentityAdapter } from './referral-ports';

/**
 * The V3.2-C referral composition root (Stories #11 and #27).
 *
 * ## It binds two ports now, and Story #11's docblock predicted exactly this
 *
 * This was *"the smallest composition module in the repository"* and bound
 * nothing, because a referral code is drawn from a CSPRNG and stored against the
 * session's own user id — no fact from any other domain participated. That
 * docblock also recorded what would change it: *Story #27 changes this.
 * Attribution has to ask `identity` how old an account is, and `V32-DEC-019`
 * binds that answer into one indistinguishable refusal — so a port will be
 * declared by `referral` and bound here, exactly as the wishlist's is.*
 *
 * This is that story, and it needs `booking` as well: eligibility is *account
 * age ≤ 30 days* **and** *no completed booking* (Issue #27, ADR-036 §4).
 *
 * `ReferralModule` declares both tokens and provides **neither**, so this module
 * failing to bind one is a boot failure rather than a permissive fallback — see
 * `referral-ports.ts` for why that asymmetry is load-bearing here specifically.
 *
 * ## Why `TypeOrmModule.forFeature` appears here
 *
 * The two adapters read `identity.users` and `booking.bookings`. They run every
 * query on the caller's `EntityManager` rather than on an injected repository
 * (bug #2 — a port that opens its own connection inside a caller's transaction
 * exhausts the pool under exactly the concurrency this route must survive), but
 * the entities must still be registered with the DataSource for
 * `manager.getRepository(...)` to resolve their metadata.
 *
 * Registering them HERE rather than widening `ReferralModule`'s own
 * `forFeature` is the boundary: `referral` never sees either entity, and the app
 * layer — which is permitted to know about all three domains — supplies them.
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
 * **No event handler, and `ReferralAttributed` is still not defined.** The
 * module consumes nothing and now emits nothing either, which is the same
 * answer for a different reason than Story #11 had: attribution IS a lifecycle
 * moment, and it still has **no consumer**. Story #12 qualifies on
 * `BookingCompleted` (`V32-DEC-018`), not on an attribution event
 * (`V32-DEC-033`, ADR-036 §10).
 *
 * **No notification category and no notification.** `V32-DEC-033` restricts
 * referral notifications to the **qualified** and **reversed** moments, and
 * neither exists yet. Claiming an invitation is not one of them.
 *
 * **No sweep scheduler**, and Story #27 does not add one although it adds two
 * things that age. `referral.referrals.expires_at` is a *pending* expiry that
 * Story #12 will read — nothing sweeps it, because expiry is a state the reward
 * path evaluates rather than a row to delete. `referral.claim_attempts` rows go
 * stale hourly and are left: `chat.send_counters` is swept by
 * `ChatRetentionService`, and the referral equivalent belongs with the retention
 * horizon Story #12 or a later operational story owns, not bolted on here.
 *
 * **Nothing from Stories #12, #13, #14, or #28.** No qualification, no reward
 * grant, no `reward_grants` or `referrer_counters` table, no monthly cap, no
 * reversal, no abuse suite, and no frontend.
 */
@Module({
  imports: [
    ConfigModule,
    ReferralModule,
    // Metadata only -- every query runs on the caller's EntityManager. See the
    // docblock, and `referral-ports.ts` for why that is required rather than
    // stylistic.
    TypeOrmModule.forFeature([UserEntity, BookingEntity]),
  ],
  providers: [
    { provide: REFERRAL_IDENTITY_PORT, useClass: ReferralIdentityAdapter },
    { provide: REFERRAL_BOOKING_PORT, useClass: ReferralBookingAdapter },
  ],
  exports: [ReferralModule],
})
export class ReferralCompositionModule {}
