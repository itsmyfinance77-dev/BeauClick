import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * The referral domain's events — V3.2-C Story #12 (ADR-037 §10).
 *
 * ## Exactly one event, and the other three are refused by name
 *
 * `V32-DEC-033` approves **`ReferralQualified` v1 and `ReferralReversed` v1 and
 * nothing else**. This file declares the first; the second belongs to Story #28
 * and is deliberately absent, because a contract nothing publishes is a promise
 * to a consumer that does not exist.
 *
 * Also absent, each for its own reason:
 *
 *  * **`ReferralAttributed`** — refused outright by `V32-DEC-033` and recorded
 *    twice already (ADR-035 §7, ADR-036 §10): it has **no consumer**. Story #12
 *    qualifies on `BookingCompleted`, not on an attribution event, so the last
 *    plausible argument for defining it has now actively been used up.
 *  * **`ReferralRewarded`** — the reward is a *field on qualification*, not a
 *    second fact. Emitting both would let a consumer observe a reward without
 *    the qualification that justifies it.
 *  * **`ReferralCapped`, `ReferralExpired`** — these are *states*, not events,
 *    and nothing consumes either. The cap outcome rides on the qualification
 *    event where it belongs.
 *
 * ## What no payload here may ever carry
 *
 * `V32-DEC-033`, verbatim: *no referral code, phone, display name, or free
 * prose in any event payload, notification payload, analytics dimension, metric
 * label, or log line. A referral code is a bearer credential for attribution and
 * never leaves the authenticated read route.*
 *
 * The schema below is the enforcement rather than the reminder: every field is
 * a uuid, an instant, a bounded integer, or a member of a closed enum, so there
 * is **no field a string could travel through**. `referral.events.spec.ts`
 * walks the registered schema and asserts exactly that — and pairs it with a
 * negative control, because a schema audit that cannot fail proves nothing.
 */

/**
 * Which side of a referral a reward outcome describes.
 *
 * Exported from the contract package rather than redeclared per module, because
 * three places need the same vocabulary: the event payload, the
 * `referral.reward_grants` CHECK constraint, and the domain that writes both.
 * Three copies of a closed set is one copy plus two things that can drift.
 */
export const REFERRAL_REWARD_SIDES = ['referrer', 'referee'] as const;
export type ReferralRewardSide = (typeof REFERRAL_REWARD_SIDES)[number];

/**
 * What actually happened to one side's reward.
 *
 * A **closed** set, and each member is a decision rather than a status string:
 *
 *  * **`awarded`** — a positive configured value was written to the loyalty
 *    ledger.
 *  * **`disabled_zero`** — the configured value is **0**. `V32-DEC-016`: zero
 *    is *honestly disabled*. Qualification is still recorded and the grant row
 *    still exists; **no ledger row is written and no idempotency slot is
 *    consumed**, so a later approved figure can still be awarded against the
 *    same referral id.
 *  * **`capped`** — the referrer's monthly cap was already spent
 *    (`V32-DEC-019`). **Referrer side only**, and the database enforces that:
 *    the referee has no cap, so a capped referee would be an owner decision
 *    quietly reversed in data.
 *
 * There is deliberately no `failed`, no `pending`, and no `unknown`. Every one
 * of those would be a state the transaction cannot produce: the whole
 * qualification either commits or does not exist (ADR-037 §5).
 */
export const REFERRAL_REWARD_OUTCOMES = ['awarded', 'disabled_zero', 'capped'] as const;
export type ReferralRewardOutcome = (typeof REFERRAL_REWARD_OUTCOMES)[number];

/**
 * A referral qualified — the referee's first `BookingCompleted` landed on a
 * pending, unexpired attribution.
 *
 * ## Why the two outcomes ride on ONE event rather than two
 *
 * The sides are independent in the schema and at the cap (`V32-DEC-019`), which
 * might suggest an event per side. They travel together because they are
 * **one transactional fact**: the qualification either happened for both or
 * happened for neither, and splitting it would let a consumer observe half of
 * an atomic outcome and reasonably conclude the other half failed.
 *
 * ## Why the point values are here at all
 *
 * A consumer needs to know whether anything moved. `referrerPoints: 0` with
 * `referrerOutcome: 'disabled_zero'` is the honest statement of a configured
 * zero, and it is materially different from `capped` — which says the platform
 * *would* have paid but the monthly cap was spent. Collapsing the two would
 * make the notification and any future consumer unable to tell "we pay nothing
 * for referrals right now" from "you have hit your limit for the month".
 */
export const ReferralQualified = defineEvent({
  name: 'ReferralQualified',
  version: 1,
  aggregateType: 'referral',
  producer: 'referral',
  description:
    "The referee's first completed booking qualified a pending referral. Carries both sides' outcomes; carries no code, phone, name, or prose.",
  idempotency:
    'Emitted inside the qualification transaction, guarded by the CAS on status=pending AND expires_at > now. A redelivered BookingCompleted affects zero rows and emits nothing, so exactly one event exists per referral.',
  schema: z.object({
    referralId: uuid(),
    referrerUserId: uuid(),
    refereeUserId: uuid(),
    /**
     * WHICH booking qualified it.
     *
     * Carried so a consumer never has to ask the booking domain, and stored on
     * the referral row for the same reason (ADR-037 §13). It is an id and
     * nothing else — no service name, no professional name, no price, no note.
     */
    qualifyingBookingId: uuid(),
    qualifiedAt: instant(),

    /**
     * Each side's outcome and the points that actually moved.
     *
     * `nonnegative()` rather than a bare `int()`, and the bound is load-bearing:
     * a reversal is a **new negative row in the loyalty ledger under a distinct
     * reason** (`V32-DEC-017`), never a negative number on a qualification. A
     * schema that admitted one would let Story #28's clawback be smuggled
     * through this event instead of through its own.
     */
    referrerOutcome: z.enum(REFERRAL_REWARD_OUTCOMES),
    referrerPoints: z.number().int().nonnegative(),
    refereeOutcome: z.enum(REFERRAL_REWARD_OUTCOMES),
    refereePoints: z.number().int().nonnegative(),
  }),
});

export const REFERRAL_EVENTS = [ReferralQualified];
