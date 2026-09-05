# ADR-044 — A booking that collects nothing online confirms itself, in one transaction, in the callback's order

**Status:** ACCEPTED — 2026-09-05
**Approver:** product owner (`V33-DEC-023` ratified 2026-09-05)
**Backlog:** #81 (`#41b`)
**Depends on:** ADR-043 (immutable order payment-schedule snapshot), ADR-039
(commercial policy is a versioned control plane), ADR-018 (same-cluster
consistency), ADR-017 (financial isolation), ADR-011 (module boundaries)
**Constrains:** #58 (`#40d`), #82 (`#41c`)

**Amended 2026-09-05 (`V33-DEC-024`) — the deposit path is disjoint from this
one, and this ADR is unchanged.** #82's contract adds a second additive order
state, `online_collection_completed`, for an order whose *positive* scheduled
collection was verified. It does not touch the zero-collectible path: the trigger
here is still `platformCollectibleToman === 0`, `online_collection_not_required`
still means BeauClick is not collecting money online now, and it still never
becomes `paid`.

The two states are mutually exclusive by their own triggers — zero versus
positive collectible — so no order can be eligible for both. The H-a lock order
this ADR fixed (§3) is inherited by the deposit callback rather than replaced:
that path writes payment facts, then the order, then the booking, which is the
same relative order for the two aggregates. #82 is **not** implemented, and
ADR-045 will record its implementation.

## Context

`CheckoutService.checkout()` creates a payment intent for **every** order and
calls `PaymentService.initiate()` only when `order.totalToman > 0`. The only
production caller of `BookingService.confirm()` is the gateway callback.

So an order with nothing to collect gets no redirect, no callback ever arrives,
and the booking sits `pending` until its hold lapses. The customer booked; the
platform quietly did not.

That is reachable today. A zero-priced service produces a schedule with
`service_total = platform_collectible = 0`, which `ck_ops_mode_consistent`
accepts as `full_payment_online`. It will be reachable far more often once #82
makes `pay_at_venue` selectable, where the service price is non-zero and the
collectible is zero.

`V33-DEC-023` ratified the public vocabulary on 2026-09-05. This ADR records how
the code implements it, and fixes the boundaries that must not drift.

## Decision

### 1. The new state is `online_collection_not_required`

`ORDER_STATUSES` gains exactly one value:

    pending | paid | partially_refunded | refunded | cancelled | online_collection_not_required

It means **BeauClick is not collecting money online now.** It does not mean
paid, free, settled, completed, waived or written off — a venue balance may
still be owed to the seller in full, and that balance is not BeauClick's money
and not BeauClick's fact.

`paid` is untouched and stays unreachable except through verified payment
(`OrderPaid`'s contract depends on it, ADR-017).

### 2. The trigger is the schedule, never the order total

The zero-collectible path is chosen by
`order_payment_schedules.platform_collectible_toman = 0` — the immutable
snapshot ADR-043 §5 writes inside the order's own transaction.

**Never `orders.total_toman = 0`.** The two agree today only because
`full_payment_online` is the only mode that has ever run, and #82 (`#41c`) exists
precisely to break that coincidence: under `pay_at_venue` the service price is
non-zero while the collectible is zero. A total-based branch would keep passing
its tests and start doing the wrong thing on the day that ships.

The schedule is already in `OrderWithDetail`, non-optional and non-null, so the
branch costs no extra query.

### 3. H-a: order, then hook, then booking — and why the order is binding

The confirmation transaction performs exactly three mutations, in this order:

1. `pending -> online_collection_not_required` on the order, by compare-and-swap;
2. the mandatory entitlement hook;
3. `BookingService.confirm()`.

The gateway callback mutates in the relative order **payment facts → order →
booking** (`applyVerification`, `markPaid`, `confirm`). The zero-collectible path
has no payment facts — creating any would violate §7 — so `V33-DEC-023` Ruling 3
(recommendation H-a) requires its two remaining mutations to keep that same
relative order: **order, then booking.**

This is a lock-order ruling, not a stylistic one. Two paths that write
`commerce.orders` and `booking.bookings` in opposite orders are a deadlock
available to any future concurrent workload — the callback taking the order row
first while the zero path holds the booking row and waits for the order. Matching
the established order makes the cycle unconstructible. It costs nothing to do now
and is expensive to retrofit after both paths have callers.

The hook sits **between** them, inside the same transaction, because #58 will
consume a booking credit there and a credit must not be spent for a booking that
then fails to confirm.

### 4. One `EntityManager`, one database transaction

All three mutations receive the caller's `EntityManager` and run in one
`dataSource.transaction`. Any failure rolls back all three.

Both tables are in the same PostgreSQL cluster (ADR-018), so a real transaction
is available and an eventually-consistent window would be a choice, not a
constraint — the same reasoning that put booking and order creation in one
transaction.

### 5. The new state emits no event

No new commerce event, no new `ServiceName` member, no order timestamp column.

`BookingConfirmed` remains the single domain fact for "this slot is now booked",
emitted by `BookingService.confirm()` through booking's existing transactional
outbox, unchanged and unaware that a new order state exists.
`booking.confirmed_at` stays the authoritative timestamp.

A new status is a **state** the platform can be in; an event is a **fact** that
something happened. The fact has not changed and already has a contract with
named consumers. Adding an event would create a second name for one occurrence
and oblige every consumer to learn both.

### 6. The hook is a mandatory port with a no-op adapter

`ZERO_COLLECTIBLE_CONFIRMATION_HOOK` is declared in `services/commerce` and bound
in the composition root, exactly as `SERVICE_CATALOG` is (ADR-011: a domain
declares the port, `apps/api` implements it).

**Mandatory, and mandatory by construction.** No `@Optional()`, no default
constructor value, no optional chaining at the call site, no catch-and-ignore. A
composition that omits the binding must fail to construct, loudly, at boot.

This is the whole reason the seam is built now rather than with #58: an optional
dependency can silently omit a money or entitlement effect, and nothing in the
tests or the logs would say so.

Its method takes the caller's `EntityManager` and the booking id **only**. No
client-supplied owner, party, subject or quantity crosses it — that is a security
boundary, not an ergonomic one: a caller-chosen party on an entitlement seam is a
grant of somebody else's credits.

`#41b` binds a no-op that creates no row and no event. #58 replaces the binding
without touching booking, commerce or payment.

*Amended 2026-09-06 (`V33-DEC-025`) — the seam is renamed and widened, not
merely rebound.* This ADR named the port for the path that first needed it, and
that name became a contract claim it cannot keep: `#82` added a second
confirmation path (`checkout.service.ts:453`) which does **not** invoke this
hook, so "the credit is consumed when a booking first enters `confirmed`" is not
satisfied by a zero-collectible-only seam. `#58a` replaces it with one
**confirmation-wide** entitlement port invoked from **both** paths, keeping this
ADR's shape rules exactly — mandatory, non-optional, `EntityManager` and
`bookingId` only, bound in the composition root, an absent binding still a boot
failure. Nothing about `#41b`'s own transaction or H-a ordering changes, and
`#58a` is not implemented.

### 7. Nothing money-shaped is created on this path

No payment intent, payment attempt, provider call, `PaymentSucceeded`,
`OrderPaid`, settlement reference, receivable, financial ledger write, loyalty
write or refund.

Intent creation **moves inside** the positive-collectible branch. Today it runs
for every order, including ones the platform will never ask a bank about; an
intent for an amount nobody will charge is a payment-domain row asserting
something untrue.

### 8. Replay, concurrency, and the state that must be impossible

The order transition is a compare-and-swap from `pending`, so exactly one caller
wins. `OrderService.confirmNoOnlineCollection()` returns a closed typed outcome
rather than a boolean:

| Outcome | Meaning |
|---|---|
| `transitioned` | this caller won the CAS |
| `already` | the order is already `online_collection_not_required` — a replay |
| `ineligible` | the schedule's collectible is positive, or the order is in a status this transition may not leave |

`BookingService.confirm()` is itself a CAS from `pending` and returns `false`
when the booking is no longer pending, so a replay produces no second history row
and no second outbox event.

On a replay the orchestrator returns the authoritative existing result **without
rerunning the hook**. Rerunning a no-op is harmless today and is exactly what
must not be inherited by #58.

**The impossible state is not repaired.** An order already
`online_collection_not_required` whose booking is not confirmed cannot be
produced by this transaction — the two commit together — so encountering it means
an invariant broke elsewhere. The orchestrator throws a plain `Error`, which
`BeauclickExceptionFilter` turns into the generic Persian `INTERNAL_ERROR` after
logging and reporting it server-side. Silently confirming the booking would
convert a broken invariant into a repaired-looking one, and the evidence would be
gone.

### 9. A positive collectible changes in exactly one way: nothing

`platformCollectibleToman > 0` keeps today's behaviour byte-for-byte — intent
creation, `initiate()`, redirect, retry, callback verification, duplicate-charge
refund, `paid but unconfirmable` auto-refund.

The charged amount stays `order.totalToman` and is deliberately **not** changed
to the collectible here. Under the only reachable mode the two are equal, and
changing the charged amount is #82's decision with its own `OrderPaid` and ledger
consequences (`V33-DEC-022` Ruling 7).

### 10. Cancellation and expiry must know "never collected" from "paid"

`OrderService.cancel()` widens from `pending`-only to `pending` **or**
`online_collection_not_required`, keeping its compare-and-swap predicate.

`BookingCancelledRefundHandler` currently branches on `status === 'pending'` and
sends **everything else** to `remainingRefundable(order)`, which is
`totalToman - refundedTotalToman`. A zero-collectible order's `totalToman` is the
venue balance — positive under `pay_at_venue` — so without this change the
handler would call the payment provider and refund money BeauClick never
collected. It now treats the new status as never-collected: cancel, no refund, no
provider call.

`BookingExpiredOrderHandler` reaches the same widened `cancel()`.

`paid`, `partially_refunded` and `refunded` behaviour is untouched.

### 11. The response keeps its keys and gains nullability

`payment: { intentId, redirectUrl }` keeps both keys and both become nullable.
Not an omitted key, which becomes `undefined` in a client compiled against a
required field; not a sentinel id, which is indistinguishable from a real one at
every call site that receives it.

## Consequences

- **Positive.** A zero-collectible booking confirms. The defect #81 was filed for is closed at its cause rather than papered over with a manual confirm route.
- **Positive.** The entitlement seam exists, is mandatory, and is proved mandatory, before #58 needs it.
- **Positive.** Both paths now write the same two aggregates in the same order, so the deadlock is unconstructible rather than merely unobserved.
- **Negative, disclosed.** `commerce.orders.status` widens from `varchar(20)` to `varchar(32)`. The new literal is 30 characters; the column would silently truncate or error otherwise. The `ck_orders_status` allowlist is replaced with one naming all six statuses — every existing value preserved.
- **Negative, disclosed.** One more status for every consumer to consider. Mitigated by the allowlist CHECK, the `satisfies` annotations, and an audit of every order-status consumer in this story.
- **Negative, disclosed.** The zero-collectible path cannot be exercised end-to-end through the public API with a *non-zero* service price until #82 makes `pay_at_venue` selectable. That case is proved at the domain layer against a controlled database fixture instead, and this ADR records the gap rather than pretending the public route covers it.

## What was deliberately not built

- Booking-credit consumption and return — **#58 (`#40d`)**, which replaces the no-op hook binding.
- Deposit execution, the intent amount becoming the collectible, the refund ceiling and the ledger amount — **#82 (`#41c`)**.
- Policy publication and selection, and any way to *choose* `pay_at_venue` — **#83 (`#41d`)**, blocked by `V33-DEC-011`/`V33-DEC-012`.
- A public confirm route. `V33-DEC-023` ratified none, and one would let a client assert a confirmation the server should decide.
- Any deposit value, percentage base, rounding value, seller choice, provider, settlement or production activation.
- Any change to `paid`, `OrderPaid`, `OrderCreated`, `OrderRefunded`, `totalToman`, refunds, ledger entries, payment-intent semantics or the booking state machine.

## Open gates

- The `OrderPaid` and financial meaning of a partial capture — `#41c`.
- Which collection modes may be enabled — `V33-DEC-011`, open under #46.
- Deposit bounds, rounding values and the percentage calculation base — `V33-DEC-012` and #46.
- Real provider collection and settlement — #47.
