import type { EntityManager } from 'typeorm';

/**
 * The two seams this module gained in Story #27 (ADR-011, ADR-036 §4).
 *
 * Story #11's `ReferralModule` declared **no** port, and ADR-035 recorded why: a
 * referral code is drawn from a CSPRNG and stored against the session's own user
 * id, so no fact from any other domain participates. Attribution is the first
 * thing here that needs somebody else's truth — how old the claimant's account
 * is, and whether they have ever completed a booking — and `V32-DEC-019` binds
 * both answers into one indistinguishable refusal.
 *
 * `referral` may not import `identity` or `booking` (ADR-011, enforced by
 * `@nx/enforce-module-boundaries`: either import inside `services/referral`
 * fails CI). So it declares what it needs and the composition root binds it —
 * the pattern `apps/api/src/composition/ai-ports.ts` established and
 * `WISHLIST_TARGET_PORT` follows.
 *
 * **`ReferralModule` deliberately provides no default implementation of
 * either.** A module that cannot boot without its ports bound is a module whose
 * boundary is real: there is nothing to fall back on, and no way to ship a stub
 * by accident. That matters more than usual here, because a permissive stub —
 * "everybody is new", "nobody has booked" — would pass every test written
 * against this module alone while disabling two of the six eligibility rules in
 * production.
 *
 * ## Both take the caller's `EntityManager`, and it is not a style preference
 *
 * Two independent reasons, either sufficient:
 *
 * **Correctness.** An eligibility fact read outside the transaction that
 * inserts the attribution row is a fact that can change between the read and the
 * write. Both of these gate a write; both must be read by the transaction that
 * performs it.
 *
 * **Connection exhaustion.** A port that opens its own connection inside a
 * caller's transaction is the defect V3.2-B recorded as **bug #2**, where N
 * concurrent senders needed 2N connections against a pool of 10 and past five
 * the suite *stopped* — with no error and no timeout. The claim route is
 * explicitly required to survive concurrent requests, so it is exactly the
 * shape that would reproduce it.
 *
 * ## Both read AUTHORITATIVE tables and nothing else
 *
 * Not the search projection, not a cache, not an analytics rollup, not a
 * denormalised browser payload, and not anything the caller sent.
 * `PublicCatalogueAiAdapter` and `WishlistTargetAdapter` both record the
 * reasoning and it transfers unchanged: a projection is eventually consistent,
 * so it can still assert a fact the platform has just changed. Discovery is fast
 * and eventually consistent; an eligibility gate is slow and strictly
 * consistent, and that is the correct way round.
 */

/**
 * How old is this account? — the ONE question `referral` asks `identity`.
 *
 * Returns the authoritative `identity.users.created_at`, or `null` when no such
 * user exists.
 *
 * ## Why a Date rather than a boolean
 *
 * The obvious alternative — `isWithinClaimWindow(manager, userId): boolean` —
 * would put the 30-day comparison in `apps/api`. That is a **product decision**
 * (`V32-DEC-019`'s claim window, Issue #27's `≤ 30 days`), and a decision
 * implemented in the composition root is a decision the boundary owns rather
 * than the domain. Worse, the boundary has no clock: it would either read the
 * wall clock — defeating the injected one that makes the boundary testable — or
 * need the cutoff passed in, at which point it is this signature with extra
 * steps.
 *
 * So the adapter answers a fact and the domain applies the rule.
 *
 * ## What `null` means, and why it is ineligible rather than an error
 *
 * A verified JWT whose subject has no row is possible during erasure and is not
 * this route's problem to diagnose. Treating it as ineligible folds it into the
 * one indistinguishable refusal; raising would make a missing account
 * distinguishable from every other refusal, which is precisely the account
 * oracle `V32-DEC-019` forbids.
 *
 * ## What it must NOT return
 *
 * Not the phone, the display name, the roles, or the row. The domain has no
 * legitimate use for any of them, and a record returned is a record that ends up
 * somewhere — in a log line, an exception message, or a response — which
 * `V32-DEC-033` forbids for referral material and ADR-027 forbids for subject
 * data this module does not own.
 */
export interface ReferralIdentityPort {
  accountCreatedAt(manager: EntityManager, userId: string): Promise<Date | null>;
}

export const REFERRAL_IDENTITY_PORT = Symbol('BEAUCLICK_REFERRAL_IDENTITY_PORT');

/**
 * Has this person ever completed a booking? — the ONE question `referral` asks
 * `booking`.
 *
 * ## Why a boolean here, when the identity port returns a value
 *
 * The two are not inconsistent. The identity port returns a fact because the
 * **rule** (30 days) is the domain's; here the rule *is* the question, and
 * `V32-DEC-018` already fixes what "completed" means from the other direction
 * when it rules that registration, `BookingConfirmed`, and `OrderPaid` never
 * qualify.
 *
 * Returning the booking would hand this module a booking id, a professional id,
 * and a date it has no use for — and a record returned is a record that ends up
 * somewhere. There is no method here that could answer *which* booking, *when*,
 * or *how many*, so no caller can construct one.
 *
 * ## Existence, not a count
 *
 * The implementation must stop at the first row (`LIMIT 1`). A count would be a
 * fact about how much a customer has transacted, which is not this module's to
 * hold, and would cost a full scan of a customer's history to answer a question
 * that is settled by one row.
 *
 * ## Why "no completed booking" is the rule at all
 *
 * `V32-DEC-019` and Issue #27 make it an eligibility condition rather than an
 * abuse control: somebody who has already completed a booking is not a newly
 * invited customer, whatever their account age says. It is the second half of
 * "new", and the account-age window alone would let a long-dormant account that
 * had transacted claim an invitation.
 */
export interface ReferralBookingPort {
  hasCompletedBooking(manager: EntityManager, userId: string): Promise<boolean>;
}

export const REFERRAL_BOOKING_PORT = Symbol('BEAUCLICK_REFERRAL_BOOKING_PORT');
