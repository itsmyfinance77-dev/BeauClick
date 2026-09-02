import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookingEntity } from '@beauclick/booking';
import { UserEntity } from '@beauclick/identity';
import { REFERRAL_BOOKING_PORT, REFERRAL_IDENTITY_PORT, ReferralModule } from '@beauclick/referral';

import { OutboxSource } from '@beauclick/events';
import { LoyaltyConfig, LoyaltyModule } from '@beauclick/loyalty';
import { NotificationModule } from '@beauclick/notification';
import { OrderEntity } from '@beauclick/commerce';
import {
  REFERRAL_LOYALTY_PORT,
  REFERRAL_LOYALTY_REVERSAL_PORT,
  REFERRAL_ORDER_LOOKUP_PORT,
  REFERRAL_REWARD_CONFIG,
  ReferralOutboxEntity,
} from '@beauclick/referral';

import { ReferralBookingAdapter, ReferralIdentityAdapter } from './referral-ports';
import {
  ReferralLoyaltyAdapter,
  ReferralLoyaltyReversalAdapter,
  referralRewardConfigFrom,
} from './referral-loyalty.adapter';
import { ReferralOrderAdapter } from './referral-order.adapter';
import { REFERRAL_EVENT_HANDLERS, REFERRAL_OUTBOX_SOURCES } from './referral-tokens';
import {
  BookingCompletedReferralHandler,
  ReferralQualifiedNotificationHandler,
} from '../events/referral-qualification.handlers';
import {
  OrderRefundedReferralHandler,
  ReferralReversedNotificationHandler,
} from '../events/referral-reversal.handlers';

/**
 * The referral domain's reads into `identity` and `booking`, `@Global()`.
 *
 * ## Why global, and why this is a separate module from the composition below
 *
 * `ReferralModule` DECLARES both tokens and provides neither, so something else
 * has to bind them. The obvious place is `ReferralCompositionModule` below —
 * **and that does not work**, for the reason `WishlistPortsModule` and
 * `AiPortsModule` both record at length, and which this story hit as a boot
 * failure before reading their docblocks:
 *
 * Nest resolves a provider through the injector of the module that DECLARES the
 * consumer, walking up through *that* module's own imports.
 * `ReferralCompositionModule` imports `ReferralModule`, so the arrow points the
 * wrong way: a token provided in the composition module is invisible to
 * `ReferralService`, and the symptom is exactly `Nest can't resolve
 * dependencies of the ReferralService (…, ?, …)`.
 *
 * So the binding lives in a `@Global()` module, as `DomainPortsModule`,
 * `AiPortsModule`, and `WishlistPortsModule` all do, and for the same reason:
 * this is an infrastructure binding a domain module needs and must not import a
 * domain to obtain.
 *
 * A domain module still cannot reach a service it should not see. Only the two
 * narrow, referral-declared tokens are exported — not `IdentityService`, not
 * `BookingService`, and not the repositories the adapters read. `referral` can
 * ask how old an account is and whether a booking was completed, and can ask
 * nothing else.
 *
 * ## `TypeOrmModule.forFeature` is repeated here on purpose
 *
 * `forFeature` is scoped to the module that registers it, so the entities being
 * available in the (`@Global`) `DomainPortsModule` does not make them resolvable
 * here — the same note `AiPortsModule` and `Phase3CompositionModule` both
 * record. The adapters run every query on the CALLER's `EntityManager`; this
 * registration exists so `manager.getRepository(...)` can resolve their
 * metadata.
 */
@Global()
@Module({
  imports: [
    // V3.2-C Story #28 adds `OrderEntity`, for the order-lookup adapter's
    // metadata. `forFeature` is scoped to the module that registers it, which
    // is why this list is repeated here rather than inherited.
    TypeOrmModule.forFeature([UserEntity, BookingEntity, OrderEntity]),
    // V3.2-C Story #12. For LoyaltyLedgerService and LoyaltyConfig, which the
    // loyalty adapter and the reward-config factory need. `referral` still
    // never sees either -- only apps/api does, which is the boundary.
    LoyaltyModule,
  ],
  providers: [
    ReferralIdentityAdapter,
    ReferralBookingAdapter,
    ReferralLoyaltyAdapter,
    // V3.2-C Story #28.
    ReferralLoyaltyReversalAdapter,
    ReferralOrderAdapter,
    { provide: REFERRAL_IDENTITY_PORT, useExisting: ReferralIdentityAdapter },
    { provide: REFERRAL_BOOKING_PORT, useExisting: ReferralBookingAdapter },
    // V3.2-C Story #12. The one reach into the loyalty ledger (ADR-037 §4).
    { provide: REFERRAL_LOYALTY_PORT, useExisting: ReferralLoyaltyAdapter },
    /**
     * V3.2-C Story #28. The clawback, behind a SECOND token (ADR-038 §§5-6).
     *
     * Separate from `REFERRAL_LOYALTY_PORT` rather than a method on it,
     * because the reward port reserved it that way in terms: *"it also cannot
     * write a negative row … that belongs to Story #28 with its own trigger
     * and its own port."* Keeping the two apart keeps the reward path's
     * guarantee -- that nothing it can do subtracts points -- a shape rather
     * than a convention, and makes the two directions separately auditable.
     */
    { provide: REFERRAL_LOYALTY_REVERSAL_PORT, useExisting: ReferralLoyaltyReversalAdapter },
    /**
     * V3.2-C Story #28. The one read into commerce (ADR-038 §3).
     *
     * `OrderRefunded` v1 carries no customer and no source, so a reversal
     * cannot tell which referral a refund concerns without re-reading the
     * order -- and re-reading is required anyway, because full-versus-partial
     * is the ORDER's authoritative status and not something the event can
     * express.
     */
    { provide: REFERRAL_ORDER_LOOKUP_PORT, useExisting: ReferralOrderAdapter },
    // The two configured reward values, read from the authoritative
    // LoyaltyConfig. ReferralModule binds a default of { 0, 0 }, so this
    // changes nothing on a default deployment -- it exists so that SETTING
    // the variables actually reaches the domain.
    {
      provide: REFERRAL_REWARD_CONFIG,
      inject: [LoyaltyConfig],
      useFactory: referralRewardConfigFrom,
    },
  ],
  exports: [
    REFERRAL_IDENTITY_PORT,
    REFERRAL_BOOKING_PORT,
    REFERRAL_LOYALTY_PORT,
    REFERRAL_LOYALTY_REVERSAL_PORT,
    REFERRAL_ORDER_LOOKUP_PORT,
    REFERRAL_REWARD_CONFIG,
  ],
})
export class ReferralPortsModule {}

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
 * `ReferralModule` declares both tokens and provides **neither**, so a
 * composition that failed to bind one is a boot failure rather than a permissive
 * fallback — see `referral-ports.ts` for why that asymmetry is load-bearing here
 * specifically.
 *
 * The binding itself lives in `ReferralPortsModule` above rather than in this
 * module, and its docblock records why that is a requirement rather than a
 * preference: a provider declared here is invisible to `ReferralService`,
 * because Nest resolves through the injector of the module that declares the
 * consumer. This module imports it FIRST, so both ports exist before
 * `ReferralModule` is instantiated.
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
 *
 * ## V3.2-C Story #28 makes all four of those paragraphs historical
 *
 * They are left standing rather than rewritten, because they were accurate when
 * written and the sequence is worth reading: the module acquired an outbox when
 * it acquired a producer, and a second consumer when a second owner decision
 * had a trigger. What is true now:
 *
 *  * the outbox source exists (Story #12) and carries **two** event types;
 *  * there are **four** handlers under one token — qualify, notify-qualified,
 *    reverse, notify-reversed;
 *  * `V32-DEC-033`'s two notification moments both exist, and the vocabulary is
 *    closed at those two;
 *  * there is still **no sweep scheduler**, and Story #28 adds none: a reversed
 *    referral is terminal and permanent, exactly as a qualified one is.
 *
 * **Nothing from Stories #13, #14 or #15.** No abuse suite, no design artifact,
 * and no frontend.
 */
@Module({
  imports: [
    ConfigModule,
    // FIRST, so every port is bound before `ReferralModule` is instantiated.
    ReferralPortsModule,
    ReferralModule,
    // For the ReferralQualified consumer. The notification module is the
    // ONLY delivery mechanism referral touches: in-app, under the existing
    // opt-outable `referral` category (V32-DEC-033). No SMS, email, push, or
    // external provider -- every one of those is externally gated.
    NotificationModule,
  ],
  providers: [
    /**
     * The four event handlers, provided here and surfaced under one token.
     *
     *   `BookingCompleted`  -> qualify, and converge if the order is already
     *                          fully refunded (V32-DEC-018, ADR-038 §8)
     *   `ReferralQualified` -> notify both parties (V32-DEC-033)
     *   `OrderRefunded`     -> reverse on a FULL refund (V32-DEC-017)
     *   `ReferralReversed`  -> notify both parties (V32-DEC-033)
     *
     * All four under one token because they are one domain's event surface, and
     * splitting them would suggest they could be composed independently — which
     * they cannot. A deployment that qualified without reversing would be a
     * platform with `V32-DEC-017`'s free-points loop open; one that reversed
     * without notifying would take points back silently.
     */
    BookingCompletedReferralHandler,
    ReferralQualifiedNotificationHandler,
    OrderRefundedReferralHandler,
    ReferralReversedNotificationHandler,
    {
      provide: REFERRAL_EVENT_HANDLERS,
      inject: [
        BookingCompletedReferralHandler,
        ReferralQualifiedNotificationHandler,
        OrderRefundedReferralHandler,
        ReferralReversedNotificationHandler,
      ],
      useFactory: (
        qualify: BookingCompletedReferralHandler,
        notifyQualified: ReferralQualifiedNotificationHandler,
        reverse: OrderRefundedReferralHandler,
        notifyReversed: ReferralReversedNotificationHandler,
      ) => [qualify, notifyQualified, reverse, notifyReversed],
    },
    // V3.2-C Story #12. The module`s first outbox source, merged by
    // DomainCompositionModule into the single OUTBOX_SOURCES the relay drains.
    // Its own token rather than OUTBOX_SOURCES directly, for the reason
    // ai-tokens.ts records: two modules both providing OUTBOX_SOURCES would
    // not merge -- the second would silently replace the first.
    {
      provide: REFERRAL_OUTBOX_SOURCES,
      useValue: [{ name: 'referral', entity: ReferralOutboxEntity }] satisfies OutboxSource[],
    },
  ],
  exports: [ReferralPortsModule, ReferralModule, REFERRAL_OUTBOX_SOURCES, REFERRAL_EVENT_HANDLERS],
})
export class ReferralCompositionModule {}
