# ADR-018: Cross-Domain Consistency Boundaries

**Status:** Accepted — implemented and verified in Phase 2 (2026-08-20).
**Related:** ADR-007 (events), ADR-011 (repository architecture), ADR-017 (financial isolation).

## Context

Phase 2 introduced four domains that must react to each other: booking, commerce, payment, financial. ADR-007 chose Kafka as the eventual transport and `V3_DATABASE_BLUEPRINT.md` §7 chose the transactional outbox as the publication mechanism. Neither says **which** cross-domain transitions should be eventual at all.

That gap matters more than it looks. The default failure mode when a project has an event bus is to route everything through it — which is how a booking ends up existing without its order, and how V2 ended up with its hardest bug: payment recorded in one step and booking confirmed in another, producing the "paid but the slot is gone" case it then had to detect and compensate for.

`ADR-011` compounds the question: no `services/*` package may import another, so no domain can call another directly even when synchronous consistency is exactly what is wanted.

## Decision

**Consistency is decided per transition, from the consistency requirement — never from what transport happens to be available.** Three categories, and the rule that assigns them:

> If two facts being separately true is a state the product cannot coherently be in, they commit together. Otherwise they are eventual.

### 1. Synchronous and atomic — one database transaction

| Transition | Why atomic |
|---|---|
| slot claim + booking creation + history + outbox row | A held slot with no booking silently removes a bookable time from a professional's day |
| booking + order creation | A booking with no order is a slot held for nothing; an order with no booking is a charge for nothing |
| payment verified + order paid + booking confirmed | **This is where V2 bled.** Separating these produces the paid-but-unconfirmable window by construction |

All of these live in schemas of the same PostgreSQL cluster, so a real ACID transaction is available. Choosing eventual consistency here would mean every reader, forever, defending against a window that does not need to exist.

**How this coexists with ADR-011:** the transaction is opened by `CheckoutService` in `apps/api` (`scope:app`, the one tier permitted to compose domains) and the `EntityManager` is passed into each service's method. No domain imports another; the composition root supplies the shared transaction. Every service method that participates takes an optional `EntityManager` and joins the caller's transaction when given one.

### 2. Eventual — via the transactional outbox

| Reaction | Why eventual |
|---|---|
| `OrderPaid` → ledger commission + receivable | financial-service is on a **different connection** (ADR-017) and *cannot* join that transaction at all |
| `RefundCompleted` → commerce records the refund | Reacting to the refund that actually happened, not the one we asked for |
| `OrderRefunded` → ledger reversal at the original captured rate | Same connection boundary |
| `BookingCancelled` → refund the linked order if paid | A refund is a bank call; holding a transaction across it would pin row locks for an external system's latency |
| `BookingExpired` → cancel the unpaid order | No user is waiting on it |

This is safe rather than merely convenient: the event row commits **with** the business write, so it cannot announce something that never happened; and every consumer is idempotent through a real database constraint or a status compare-and-swap, so at-least-once delivery plus an idempotent consumer is exactly-once in effect.

### 3. Not events at all

booking-service fires **facts** (`BookingCancelled`) and never decides financial consequences. commerce and payment decide those. This is V2's separation of concerns, preserved deliberately — inverting it would put refund policy inside the scheduling domain.

### Transport

Phase 2 ships an **in-process relay**, not Kafka. There is no broker in this environment, and standing one up would be Phase 3 infrastructure work arriving inside a domain phase. What Phase 2 builds is the part that determines correctness: the transactional outbox, versioned envelopes, and an idempotent-by-contract consumer interface. Swapping the dispatcher for a Kafka producer changes **one file** — no producer writes to a broker directly, and no consumer knows how the envelope reached it.

Delivery is at-least-once by construction: rows are dispatched first and marked published second, because the opposite order loses events when a process dies mid-dispatch.

## Consequences

- **Positive:** the paid-but-unconfirmable window is closed by construction rather than compensated for. Where it can still occur (the hold lapsed while the customer was at the gateway), the payment record stands — the money moved — and an automatic, deterministically-keyed refund follows after commit.
- **Positive:** every eventual reaction is genuinely eventual for a *stated* reason, not by default. The reasons are auditable: a future reviewer can ask whether the reason still holds.
- **Negative:** `CheckoutService` knows about three domains. That is real coupling, deliberately concentrated in one file in the one tier allowed to have it, rather than spread thin across four services that each pretend not to know about the others.
- **Negative:** service methods carry an optional `EntityManager` parameter, which is transaction plumbing visible in a domain signature. The alternative — a transaction context in async-local storage — hides the plumbing at the cost of making it impossible to see, from a method's signature, whether it participates in a caller's transaction.
- **Risk:** the in-process relay means a single process failure delays (never loses) delivery until the periodic sweep runs. Acceptable at current scale; the outbox is what makes it recoverable.

## Alternatives considered

- **Everything eventual.** Rejected: it manufactures the exact window V2 spent a release compensating for.
- **Everything synchronous.** Impossible — financial is on a different connection by design (ADR-017), and refunds are external network calls.
- **A saga/process manager for booking→order.** Rejected: correct for genuinely distributed resources, pure overhead for two schemas in one cluster with a real transaction available.
- **Kafka in Phase 2.** Deferred, and disclosed as deferred rather than described as done. The correctness-bearing half is built; the transport is a swap.
