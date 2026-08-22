# ADR-024: Waitlist as an Offer That Never Reserves, Proven Against Real Concurrency

**Status:** Accepted — implemented in Phase 4.
**Date:** 2026-08-22.
**Relates to:** the booking atomic-claim guarantee (`BookingService.claimSlot()`), ADR-011.
**Closes:** GAP-26 ("waitlist offer does not automatically reserve the slot") — restated for V3, not reopened.

## Context

V2's `WaitlistMatcher` docblock recorded a deliberate product decision: waitlist is "a reasonable, testable policy, not a complicated auction." An offer tells a customer a slot *might* be theirs; it does not hold it. This phase's brief explicitly asked to prove — not merely assert — that this invariant survives real concurrency: two candidates, one reopened slot, simultaneous acceptance attempts, offer expiry, and a slot that reappears must never produce two valid bookings.

Two designs were available for what an "offer" mechanically is:

1. **A real hold** — the waitlist offer sets `availability_slots.status = 'held'`, exactly like a booking's own pending hold.
2. **A pure invitation** — the offer is waitlist-service's own state, and accepting it means *attempting* the exact same atomic claim any other customer would use, which can still be lost.

Design 1 would have been a smaller diff (reuse `claimSlot()`'s predicate for the offer itself) but changes the product's actual promise: a slot "offered" to a waitlist candidate would no longer be genuinely bookable by a faster direct customer, silently reintroducing the auction V2 explicitly rejected.

## Decision

**An offer is a pure invitation (design 2).** `waitlist.entries` never writes to `booking.availability_slots`. The matcher's atomic `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` claims a **waitlist entry**, not a slot — the slot itself is never touched until a real booking attempt.

```
BookingCancelled / BookingExpired / WaitlistDeclined / WaitlistExpired
        |
        v
WaitlistMatcherHandler -- checks the slot is still 'open' (best-effort freshness only)
        |
        v
WaitlistService.offerNextFor(professionalId, slotId, serviceId)
   -- atomic: earliest 'waiting' entry -> 'offered', FOR UPDATE SKIP LOCKED
   -- backstop: partial unique index on (offered_slot_id) WHERE status='offered'
        |
        v
customer calls accept() --> WaitlistAcceptanceService (composition root)
   ONE transaction:
     1. WaitlistService.claimOfferForAcceptance() -- CAS offered->accepted, verifies
        customer + not expired
     2. BookingService.create() -- THE SAME atomic slot claim every booking uses
     3. WaitlistService.recordResultingBooking()
   if step 2 throws SlotUnavailableException: the WHOLE transaction rolls back
   (including step 1's CAS), then markMissed() runs in a FRESH transaction
```

### Why the two-transaction split in `accept()`

Step 2's failure must not corrupt step 1's state, but it also must not be silently swallowed. Rolling back the whole transaction is what makes "lost the race" and "never happened" indistinguishable at the database level — the entry reverts to exactly `offered`, as if the accept attempt had not run. A **second**, independent transaction then moves it to `missed`, specifically because the slot is now genuinely gone and the matcher must never re-offer it. This is the identical shape `CheckoutService` already established for booking+order: cross-domain atomicity where it is required (the claim), a separate step where a synchronous transaction would be wrong (recording the honest outcome of a race that was already decided).

### No `SlotOpened`, no `WaitlistMatched`

The brief that scoped this phase named both as candidate events. Neither exists:

- **`WaitlistMatched` would duplicate `WaitlistOffered` byte-for-byte.** In this design, matching and offering are the same atomic operation — there is no earlier moment "matched" could name that "offered" doesn't already cover.
- **`SlotOpened` would be a synthetic event consumed only by the matcher**, which already reacts directly to `BookingCancelled`/`BookingExpired` (both of which carry `slotId`). Inventing an intermediate event nothing else would ever subscribe to is redundant plumbing, not a real seam.

### Four triggers, one reaction

`WaitlistMatcherHandler` is registered four times — for `BookingCancelled`, `BookingExpired`, `WaitlistDeclined`, and `WaitlistExpired` — constructed manually with a fixed `eventType`, mirroring `BookingSignalSearchHandler`'s Phase 3 pattern. All four mean the identical thing ("this professional's slot might be available again"); the difference is only which real-world action caused it.

## Consequences

- **Positive, proven not asserted:** `waitlist-concurrency.pg-spec.ts` fires a waitlist `accept()` and a direct competing customer's `create()` with `Promise.allSettled` and no `await` between them, against real PostgreSQL. Exactly one side wins; the loser's entry becomes `missed`, never a phantom booking.
- **Positive:** idempotent under redelivery at two independent layers — `FOR UPDATE SKIP LOCKED` (the primary mechanism, mirroring `claimSlot()`'s own two-layer discipline) and the partial unique index on `offered_slot_id` (the backstop, proven directly by firing two concurrent `offerNextFor()` calls for the same slot).
- **Negative, disclosed:** a customer who is offered a slot and does nothing gets no push notification faster than the offer-expiry sweep's interval — the sweep is a real backstop here (see `outbox-sweep.scheduler.ts`), not a formality, since nothing else expires a stale offer in real time. `WaitlistOffered` does trigger an immediate in-app notification (the 'waitlist' notification category this codebase had already reserved but never used), which covers the common case; only a client that never received/read it depends on the sweep.
- **Negative, disclosed:** the eligibility rule ("does this waiting entry match this reopened slot's service?") lives in one raw SQL predicate in `WaitlistService.offerNextFor()` rather than TypeORM query-builder code, because the predicate needs `FOR UPDATE SKIP LOCKED` inside a correlated `UPDATE ... WHERE id = (SELECT ...)` shape the query builder cannot express — the same reason `BookingService.claimSlot()` is raw SQL too.
