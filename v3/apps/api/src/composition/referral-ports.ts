import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { BookingEntity } from '@beauclick/booking';
import { UserEntity } from '@beauclick/identity';
import type { ReferralBookingPort, ReferralIdentityPort } from '@beauclick/referral';

/**
 * The referral domain's two cross-domain READS (ADR-011, ADR-036 §4).
 *
 * ## Why these live here and not in `ReferralModule`
 *
 * ADR-011 forbids a domain from importing another and lint enforces it: an
 * `@beauclick/identity` or `@beauclick/booking` import inside
 * `services/referral` fails CI. `apps/api` is `scope:app` and is the one place
 * permitted to depend on every domain, so this is where a cross-domain read is
 * written down.
 *
 * `ReferralModule` declares both tokens and provides **neither**, so a
 * composition that forgets one fails to boot rather than falling back to
 * something permissive. That matters more than usual here: a stub answering
 * "everybody is new" and "nobody has booked" would pass every test written
 * against the referral module alone, and would silently disable two of the six
 * eligibility rules `V32-DEC-019` requires — in a route whose whole design is
 * that a caller cannot tell which rule refused them.
 *
 * ## Both take the caller's `EntityManager` and USE it
 *
 * Two independent reasons, either sufficient.
 *
 * **Correctness.** Both facts gate a write, so both must be read by the
 * transaction that performs the write. A fact read on another connection is a
 * fact that can change between the read and the insert.
 *
 * **Connection exhaustion.** A port that opens its own connection inside a
 * caller's transaction is the defect V3.2-B recorded as **bug #2**, where N
 * concurrent senders needed 2N connections against a pool of 10 and past five
 * the suite *stopped* — with no error and no timeout, which is why it cost so
 * much to find. Story #27 is explicitly required to survive concurrent claims,
 * so it is exactly the shape that would reproduce it.
 *
 * There is consequently **no `@InjectRepository` in this file**. Both adapters
 * take entity metadata from the imported entity class and run every query on
 * the manager they were handed. `WishlistTargetAdapter` keeps injected
 * repositories for their metadata and queries the manager; here there is no
 * metadata worth injecting for, so the dependency is dropped entirely rather
 * than kept as decoration.
 *
 * ## Both read AUTHORITATIVE tables, never a projection
 *
 * `PublicCatalogueAiAdapter` and `WishlistTargetAdapter` both record the
 * reasoning and it transfers unchanged: the search projection is eventually
 * consistent, so it can still assert a fact the platform has just changed.
 * Discovery is fast and eventually consistent; an eligibility gate is slow and
 * strictly consistent, and that is the correct way round.
 *
 * Here the point is sharper than for the wishlist, because the consequence is
 * not a stale badge: reading a cached account age would let somebody whose
 * account is 400 days old claim an invitation, and reading a denormalised
 * booking summary would let somebody who has completed a booking claim one.
 * Neither would ever surface as an error.
 */

/**
 * `identity.users.created_at`, for the claim window.
 *
 * ONE column from ONE row, selected explicitly. Not `findOne` without a
 * `select`, and the difference is not performance: an entity load would pull
 * the phone, the display name, and the roles into the referral domain's call
 * stack, where they have no business being and where an exception serialiser or
 * a debug log could pick them up. What crosses this boundary is a `Date`.
 *
 * **The soft-deleted are not filtered out, and that is deliberate.** A
 * `deleted_at IS NULL` predicate here would make a soft-deleted account
 * ineligible for a *different reason* than an old one — which is invisible to
 * the caller, since both produce the same collapsed refusal, but would mean
 * this adapter encoded an eligibility rule `V32-DEC-019` never stated. A
 * soft-deleted account cannot authenticate, so it cannot reach this code path
 * at all; adding the predicate would guard nothing and would put a rule in the
 * composition root.
 */
@Injectable()
export class ReferralIdentityAdapter implements ReferralIdentityPort {
  async accountCreatedAt(manager: EntityManager, userId: string): Promise<Date | null> {
    const row = await manager.getRepository(UserEntity).findOne({
      where: { id: userId },
      select: { createdAt: true },
    });

    // `null` rather than a throw. A verified JWT whose subject has no row is
    // possible during erasure, and the domain folds it into the one
    // indistinguishable refusal -- raising here would make a missing account
    // distinguishable from every other refusal, which is precisely the account
    // oracle `V32-DEC-019` forbids.
    return row?.createdAt ?? null;
  }
}

/**
 * Whether this person has ever completed a booking.
 *
 * `booking.bookings.customer_id` is the **user** id — the person who booked —
 * and `status = 'completed'` is the single terminal state the booking machine
 * uses for a fulfilled appointment. `confirmed`, `pending`, `cancelled`,
 * `expired`, and `no_show` are all *not* completed, and `V32-DEC-018` draws the
 * same line from the other direction when it rules that registration,
 * `BookingConfirmed`, and `OrderPaid` never qualify a referral.
 *
 * ## Existence, not a count, and it stops at the first row
 *
 * `exist()` compiles to `SELECT 1 … LIMIT 1`, served by the existing
 * `ix_bookings_customer_status` index on `(customer_id, status)`. A `count()`
 * would scan a customer's whole history to answer a question one row settles,
 * and would hand the referral domain a number describing how much somebody has
 * transacted — which is not its data to hold.
 *
 * Nothing about the booking crosses this boundary: not its id, not the
 * professional, not the date. There is no method here that could answer *which*
 * booking or *when*, so no caller can construct one.
 *
 * ## Why `customer_id` and not `customer_user_id`
 *
 * `booking`'s column predates ADR-027's `_user_id` suffix convention and is a
 * user id despite the name. The suffix is a *heuristic* the coverage check uses
 * to catch an under-claimed table, not the claim itself — `booking` declares its
 * own disposition explicitly — so this is a naming inconsistency in another
 * module's table rather than a coverage gap, and renaming it is not Story #27's
 * to do. It is noted here because a reader checking this adapter against the
 * ADR-027 rules will notice it and should not have to re-derive that it is
 * fine.
 */
@Injectable()
export class ReferralBookingAdapter implements ReferralBookingPort {
  async hasCompletedBooking(manager: EntityManager, userId: string): Promise<boolean> {
    return manager.getRepository(BookingEntity).exist({
      where: { customerId: userId, status: 'completed' },
    });
  }
}
