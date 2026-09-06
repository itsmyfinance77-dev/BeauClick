# ADR-046 — A credit is spent when a booking becomes real, and the ledger is the facts

**Status:** ACCEPTED — 2026-09-06
**Approver:** product owner (`V33-DEC-025` ratified 2026-09-06)
**Backlog:** #58 (`#58a`)
**Depends on:** ADR-042 (seller subscription foundation), ADR-044 (zero-collectible
confirmation), ADR-045 (deposit capture and collected accounting), ADR-027
(subject-data contract), ADR-018 (same-cluster consistency), ADR-011 (module
boundaries)
**Constrains:** #95 (`#58b`), #57 (`#40c`)

## Context

`V33-DEC-010` ruled that a booking credit is consumed once, at first
`confirmed`, keyed by booking id, and returned as a separate immutable fact.
`#56` shipped the grants that make a balance possible. Nothing consumes them.

Two facts shape everything below.

**The seeded base plan grants zero credits.** `D-7`'s published plan version
carries `included_booking_credits = 0`, and the migration says why in its own
words: *"the absence of an entitlement, never a choice of one"*. Every seller is
lazily placed on that plan, so **every seller's balance is zero today**. Turning
on fail-closed enforcement would refuse the next confirmation of every seller on
the platform.

**The existing entitlement seam covers one of two confirmation paths.** There are
exactly two production callers of `BookingService.confirm` —
`checkout.service.ts:331` on the zero-collectible path, which invokes the hook,
and `checkout.service.ts:453` on the verified-capture path, which does not. "One
credit at first `confirmed`" is not satisfied by a seam the paid path never
enters.

`V33-DEC-025` ratified the answer to both. This ADR records how the code
implements it.

## Decision

### 1. The ledger is the facts, not a counter

    balance(party) = Σ grants.quantity
                   − count(consumptions not returned)

Three immutable tables, no mutable balance column anywhere. A counter cannot be
audited against its own history, and it turns every concurrent confirmation into
contention on one row for a value that is a pure function of rows that already
exist.

`commercial.booking_credit_consumptions` carries **one row per booking**, forced
by `uq_bcc_booking_once UNIQUE (booking_id)`. That single constraint is the whole
replay story: a redelivered callback, a concurrent duplicate confirmation and a
retried request all collide on it and write nothing.

`commercial.booking_credit_returns` carries **at most one row per consumption**,
forced by `uq_bcr_consumption_once UNIQUE (consumption_id)`. A return never
updates or deletes the consumption; the pair reads as history rather than as a
balance that moves.

Both tables reject `UPDATE` and `DELETE` by trigger, in the shape
`commerce.reject_order_payment_schedule_rewrite()` established for the order
schedule.

### 2. Selective enforcement: dormant is not exhausted

This is the safety property the whole story turns on, so it is stated as a rule
rather than left to a query:

| Party state | Derived balance | Outcome | Confirmation |
|---|---|---|---|
| Never held a grant with `quantity > 0` | 0 | `not_configured` | **proceeds**, no consumption written |
| Holds a positive grant, balance available | > 0 | `consumed` | proceeds, one consumption |
| Holds a positive grant, balance spent | 0 | `insufficient_credit` | **refused** |
| Booking already consumed | — | `already_consumed` | proceeds, nothing extra |

**Dormant and exhausted are the same number and opposite meanings.** Collapsing
them is exactly how a rollout state becomes a permanent free entitlement, so they
are separate outcomes computed from *different* questions: "has this party ever
been granted anything positive?" and "is anything left?".

A zero-quantity grant never activates enforcement and never contributes balance —
`D-7`'s grant is such a row, which is why every seller is dormant today rather
than locked out.

**No code constant, default, fallback or seed confers a positive allowance.**
`V33-DEC-009` forbids it, and a repository check already enforces that against
the catalogue.

Global fail-closed enforcement is `#95` (`#58b`), blocked on #46.

### 3. One confirmation-wide port

`ZeroCollectibleConfirmationHook` is replaced by
**`BookingConfirmationEntitlementHook`** — the same shape, the honest name, and a
second call site.

- Declared in `services/commerce` (which both checkout paths already import),
  bound in the composition root. ADR-011 unchanged: the domain declares, `apps/api`
  implements.
- `onBookingConfirmation(manager, bookingId)` — the caller's `EntityManager` and
  the booking id, and **nothing else**. No owner, party, subscription, grant,
  quantity, mode or client-derived field. A caller-supplied party on an
  entitlement seam is a grant of somebody else's credits chosen by the caller.
- **Mandatory.** No `@Optional()`, no default, no optional chaining. A
  composition without the binding fails to construct at boot, exactly as
  `V33-DEC-023` Ruling 8 required.
- Invoked from **both** paths inside the caller's existing transaction, before
  `BookingService.confirm`.

### 4. Allocation and the last-credit race

Grants are allocated **oldest first**, `granted_at ASC, id ASC`. Deterministic
and tie-broken. **No expiry behaviour is invented**: `ck_booking_credit_grants_no_expiry`
pins `expires_at` to `NULL`, so there is no expiring entitlement to prefer, and a
future expiry decision may version this rule visibly.

Two different bookings racing for one remaining credit must not both succeed. A
conditional `INSERT ... SELECT` alone **cannot** prevent that: under
`READ COMMITTED` both transactions read a balance of one, neither sees the
other's uncommitted row, and both insert.

So the service takes a **transaction-scoped advisory lock on the snapshotted
party** before it reads anything:

    SELECT pg_advisory_xact_lock(BOOKING_CREDIT_LOCK_NAMESPACE, hashtext(partyId))

The mechanism, and the namespace-uniqueness discipline, are the ones already
shipped for the AI conversation cap. Serialising per party is the correct grain:
two bookings for different sellers never contend, and two for the same seller
genuinely must.

`uq_bcc_booking_once` remains independently necessary — the advisory lock stops
*different* bookings over-spending, the unique constraint stops the *same*
booking being charged twice. Neither subsumes the other.

### 5. Lock order, and why it cannot deadlock

Within the confirmation transaction the order is fixed:

    order row  →  booking row  →  advisory lock (party)  →  commercial rows

Both existing checkout paths already take the order before the booking (ADR-044's
H-a ruling, inherited by ADR-045's callback), and the advisory lock is acquired
**after** both and released at commit. Because the advisory lock is last and no
path takes a commercial row before a booking row, no cycle exists between the two
orderings. The booking row is locked `FOR UPDATE` while still proven `pending`,
so a credit cannot be written for a booking that another transaction is
simultaneously confirming.

### 6. Consumption and confirmation commit together — except where money already moved

**Zero-collectible path (ADR-044).** `insufficient_credit` throws. The whole
transaction rolls back: no consumption, no order transition, booking still
pending. **No refund** — nothing was collected.

**Verified-capture path (ADR-045).** The payment facts and the capture are
authoritative and must survive. The port is invoked *before* confirmation, and
`insufficient_credit` is treated exactly as an unavailable booking already is:
the capture commits, **no consumption is written**, the booking stays
unconfirmed, and the existing compensation refunds precisely
`VerificationOutcome.amountToman` under its deterministic idempotency key.

That is the resolution of the apparent conflict between "money must commit" and
"credit and confirmation are atomic": **a credit is never written unless the
confirmation in the same transaction succeeds**, and the money fact is preserved
by the path #82 already built for exactly this shape. No savepoint, no second
connection, no asynchronous compensation, no event.

### 7. The charged party is snapshotted, twice

The party comes from the order's immutable `seller_party_type` /
`seller_party_id`, which is written at order creation and therefore fixed before
either confirmation path runs. It is then **snapshotted again on the consumption
row**.

Live `business_staff` affiliation is never re-resolved, and no caller or event may
supply a party. This restates for credits what `V33-DEC-020` ruled for finance
reads: current affiliation must not decide historical money. A professional who
joins or leaves a salon after a booking was charged does not move that charge, and
its return goes back to the party that paid it.

Missing, non-unique or inconsistent booking/order facts **fail closed** rather
than charging somebody else.

### 8. Returns are synchronous, and narrow on purpose

A return is written **inside the cancellation transaction**, through a mandatory
`BookingCancellationEntitlementHook` declared in `services/booking` and bound in
the composition root. A cancellation that rolls back leaves no return; a return
that fails rolls back the cancellation.

Only cancellations that are **reachable and already authorised** qualify:

| Actor | Reachable via | Returns? |
|---|---|---|
| `professional` | the cancel route, via `BookingPartyResolver.roleFor` | **yes** |
| `system` | expiry and compensation handlers | **yes**, when a *confirmed* booking is cancelled |
| `customer` | the cancel route | **no** — retention is `V33-DEC-013`/#46 |
| `admin` | in the database CHECK, produced by **no** production route | **no** |
| `business` | **does not exist** in the actor vocabulary | n/a |

`roleFor` returns only `customer` or `professional`, so the issue's original
claim that business and administrator cancellations return a credit described
identities the platform does not have.

A pending booking that expires consumed nothing, so it returns nothing.
Rescheduling neither consumes nor returns — the consumption stays attached to the
grant, subscription and `period_index` it was written with, which is what makes
"charged to term N stays charged to term N" structural rather than remembered.

**No commercial event.** No independent consumer exists — the balance is read
directly — and `V33-DEC-024` bars an event added for symmetry.

### 9. Audit, privacy and surface

Real consumptions and returns are audited in their own transaction with closed
server-authored actions. `not_configured`, `already_consumed` and other no-ops
are **not** audited as though a credit moved. No customer cancellation prose
reaches commercial audit, events, logs or metrics.

Both tables are **retained** business records under ADR-027, claimed by the
commercial subject-data contract. Erasure preserves the seller's entitlement
ledger; a consumption names a booking id and the charged party and carries no
customer identity.

**No new HTTP route**, no balance surface, no admin surface. No request or
response DTO gains an owner, party, grant, subscription, period, quantity or
entitlement field. Existing bookings stay readable, reschedulable and cancellable
at zero balance; only a genuinely new first confirmation can be refused.

## Consequences

- **Positive.** The balance is provable from immutable rows, and both the same-booking and different-booking races are closed by different mechanisms that do not rely on each other.
- **Positive.** Enforcement can ship before a commercial value exists, without either locking sellers out or inventing a free allowance.
- **Negative, disclosed.** Two questions are asked where one number would do — "ever granted?" and "any left?" — and the second table exists only to leave the first untouched. That is the cost of making dormant and exhausted distinguishable, and it is the point.
- **Negative, disclosed.** The advisory lock serialises confirmations per seller party. Two customers booking the same seller at the same instant queue briefly. Correct, and the alternative is over-spending.
- **Negative, disclosed.** `insufficient_credit` on the paid path produces a refund rather than a pre-payment refusal, because the platform cannot know the seller's balance before the gateway is asked. #57 and #95 may later make a pre-check possible; today the honest behaviour is to give the money back.

## What was deliberately not built

- Global fail-closed enforcement — **#95 (`#58b`)**, blocked on #46.
- Any positive quantity, grace, expiry, overage, cutoff, retention rule, no-show penalty or notification threshold — **#46**.
- `custom_purchase` grants; `ck_booking_credit_grants_source` is **not** widened — **#57**.
- Customer-cancellation return or retention — **#46**.
- Any commercial event, `ServiceName`, HTTP route, balance response or client selector.
- Any change to booking, order, payment or ledger semantics.

## Open gates

- The production-positive grant or allowance source, and the rollout treatment for existing sellers — #46, then #95.
- Customer-cancellation return, no-show retention and cutoffs — `V33-DEC-013`, #46.
- Credit expiry, if it is ever approved — would version the allocation rule in §4.
- Paid purchase of credits — #57, itself gated by #47.
