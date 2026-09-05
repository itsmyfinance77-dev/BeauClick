# ADR-045 — The order records what BeauClick collected, and nothing it did not

**Status:** ACCEPTED — 2026-09-05
**Approver:** product owner (`V33-DEC-024` ratified 2026-09-05)
**Backlog:** #82 (`#41c`)
**Depends on:** ADR-043 (immutable order payment-schedule snapshot), ADR-044
(zero-collectible confirmation), ADR-039 (commercial policy control plane),
ADR-018 (same-cluster consistency), ADR-017 (financial isolation), ADR-011
(module boundaries)
**Constrains:** #83 (`#41d`)

## Context

`commerce.orders.total_toman`, the payment intent's amount, the ledger
receivable and the refund ceiling are today **one number wearing four names**.
They coincide only because `full_payment_online` is the one collection mode that
has ever run.

`#41a` separated the three amounts in a snapshot; `#41b` handled the case where
the collectible is zero. This story handles the remaining case — a **positive**
collectible smaller than the service total — and the moment those four numbers
stop agreeing, three shipped behaviours become wrong:

- `CheckoutService` asks the gateway for `order.totalToman`, which is more than
  the platform is entitled to collect;
- `OrderPaidLedgerHandler` posts that same figure as the receivable, recording a
  claim on money the seller collects at their own counter;
- the refund ceiling is `total_toman`, so a customer could be refunded a venue
  balance BeauClick never held.

`V33-DEC-024` ratified the contract. This ADR records how the code implements it.

## Decision

### 1. `OrderPaid v1` does not move, and a new fact is added beside it

`OrderPaid v1` keeps its **name, version, schema and payload byte-for-byte**, and
means exactly what it has always meant: a gateway confirmed that the **whole
service total** moved.

A verified positive capture **below** the service total emits a distinct
**`OrderCollectionCaptured v1`**, whose payload names the three amounts
separately — `serviceTotalToman`, `platformCollectedToman`, `venueBalanceToman`.
**No field in the new event is called `totalToman`**, because that name is
precisely the ambiguity this story exists to remove.

**Exactly one of the two is emitted per legitimate capture, never both.** The
capture statement decides by comparing the verified amount with the service
total, and emits one event in the same transaction.

**No `OrderPaid v2`.** The outbox relay indexes and dispatches handlers by
`eventType` alone (`outbox.relay.ts`); `DomainEventHandler.eventVersion` is
declared and never read; and `parseEnvelope` throws on a version mismatch. Every
contract in the catalogue is `version: 1`, so versioning has never been
exercised. A same-name v2 would reach the v1 loyalty handler and throw on every
delivery — a poison outbox row retried for ever. Making the relay version-aware
is real work in shared infrastructure and is not this story's.

### 2. `online_collection_completed` says one thing

The scheduled **online** collection for this order completed. It does not mean
paid in full, delivered, settled, or paid at the venue — a venue balance may
still be owed to the seller, and that balance is not BeauClick's money.

    pending --> paid                          (collected == service total)
       |
       ├──▶ online_collection_completed       (0 < collected < service total)
       |        └──▶ partially_refunded ──▶ refunded
       |        └──▶ cancelled (through refund of collected money)
       |
       └──▶ online_collection_not_required    (ADR-044, collectible == 0)

`paid` stays reserved for verified full capture. ADR-044's state is unchanged and
disjoint: the two are selected by mutually exclusive triggers — zero versus
positive collectible — so no order can be eligible for both.

### 3. `collected_total_toman` is the captured principal, and it never falls

`commerce.orders.collected_total_toman BIGINT NOT NULL DEFAULT 0` is the
commerce-owned projection of gateway-verified money allocated to the order.

- **Zero before capture.**
- **Set once, atomically**, inside the verification transaction, from
  `VerificationOutcome.amountToman` — the server-side verified figure, never a
  callback parameter and never a client field.
- **Must equal the immutable schedule's `platform_collectible_toman`**, proved
  inside the same statement. A capture that does not match the schedule the order
  agreed to is not a capture this order accepts.
- **Never reduced by refunds.** It is the principal that was captured, not a
  balance. `refunded_total_toman` moves; this does not.
- **Never reconstructed from `total_toman`.**

The database enforces the chain:

    0 <= refunded_total_toman <= collected_total_toman <= total_toman

`ck_orders_refund_within_total` is **replaced** by `ck_orders_refund_within_collected`.
After the backfill this is strictly tighter, so nothing legal becomes illegal.

### 4. The capture is one statement, and it proves its own preconditions

`OrderService.recordVerifiedCapture()` replaces the unconditional `markPaid()`.
A single `UPDATE ... FROM ... RETURNING` proves, atomically:

1. the order is still `pending` (compare-and-swap);
2. `collected_total_toman = 0`, so it is written exactly once;
3. the verified amount is **positive**;
4. it **equals** the joined schedule's `platform_collectible_toman`;
5. the collectible does not exceed the order total;
6. the resulting status is `paid` when the amount equals the service total, and
   `online_collection_completed` otherwise.

Deciding the status inside the same statement is what makes "exactly one event"
true: the statement returns the status it wrote, and the caller emits the one
event that matches. There is no window in which a second reader could disagree.

A replayed callback finds `status <> 'pending'`, affects zero rows, and returns
`already` — no second capture, no second event, no second ledger entry.

### 5. Refunds are bounded by what was collected

`recordRefundWithin`, its CAS predicate, the terminal-status calculation, the
replay guard and `remainingRefundable` all read `collected_total_toman`.

- A refund of `remaining collected + 1` is refused **even when it is below the
  service total** — the exact case today's ceiling permits.
- `refunded` means the refunded amount reached the **collected principal**;
  `partially_refunded` means some collected principal remains.
- `online_collection_completed` joins `paid` and `partially_refunded` as a
  refundable status.
- The predicate stays inside the UPDATE's own WHERE clause, so concurrent refunds
  cannot interleave between check and write.

### 6. The ledger records collected money only

`OrderPaidLedgerHandler` is generalised to a capture handler bound to both
events. It posts `platformCollectedToman` — which for a full capture *is* the
service total, so full-online behaviour is byte-identical.

**`venueBalanceToman` is never posted** to any ledger entry, receivable,
liability, settlement batch or balance, and commission is never calculated on it.
Refund reversal keeps its existing shape: at the rate recorded on the original
entry, and now automatically bounded by collected money because the original
entry is.

The general commercial commission **basis** — whether commission accrues on the
service price — stays open under #46 and is not decided here.

### 7. Every `OrderPaid` consumer, classified

| Consumer | Classification |
|---|---|
| `OrderPaidLedgerHandler` (`financial-projection.handlers.ts`) | **New-capture consumer** — bound to both events, posts the collected amount |
| `payment_succeeded` notification (`notification-analytics.handlers.ts`) | **New-capture consumer** — a second mapping shows the collected amount; the `OrderPaid` mapping is unchanged |
| Analytics ingestion / rollup (`ingestion.service.ts`, `rollup.service.ts`) | **New-capture consumer** — a separate fact whose measure is the collected amount. The existing `OrderPaid` metric stays full-payment-only, so historical revenue is not silently redefined |
| `OrderPaidLoyaltyHandler` (`loyalty-journey.handlers.ts`) | **Full-capture only, intentionally** — awards nothing for booking orders anyway; a deposit must not broaden loyalty |
| Journey timeline (`loyalty-journey.handlers.ts`) | **Full-capture only, intentionally** |
| Referral qualification / reversal (`referral-ports.ts`) | **Intentionally unaffected** — `OrderPaid` never qualifies a referral, and neither does a deposit |
| `analytics.controller.ts` ingestion allowlist | **New-capture consumer** — the new name is added so the fact can be ingested at all |

No string-keyed consumer is left unclassified.

### 8. Execution is schedule-driven and mode-agnostic

Production code reads the immutable schedule and does the right thing for
whatever it finds. There is no branch asking which mode was selected, because
nothing may select one yet.

No public or client-supplied collection-mode selector, no hard-coded deposit
amount or percentage, no code-registered production policy, and no part of #83.
Public order creation still writes only `full_payment_online`; the exact-set test
proving that stays exact.

Deposit evidence plants a valid deposit schedule through an internal
real-PostgreSQL fixture — `ck_ops_mode_consistent` refuses a fixture that is not
a real deposit — and drives the genuine intent, sandbox provider, verification,
callback, order, booking, event and ledger pipeline.

### 9. Migration and backfill

Historical rows are classified from their own lifecycle, never guessed:

- `pending`, `cancelled` and `online_collection_not_required` collected nothing → `0`;
- `paid`, `partially_refunded` and `refunded` were full-online captures → `total_toman`.

The migration then **verifies** the chain across every row and **fails loudly**
on any row it could not classify or that violates the invariant, rather than
coercing it.

### 10. What is preserved exactly

Amount and currency mismatch protection (which compares against the *intent*
amount and therefore needs no change), same-intent attempt reuse, callback
replay, genuine-second-charge `duplicate_charge` correction — which never touches
`collected_total_toman` or the order's refund accounting — the
paid-but-unconfirmable compensation path, which now refunds the **verified
captured amount** rather than the order total, and the retry vocabulary, under
which a successfully captured deposit is not retryable because the order is no
longer `pending`.

## Consequences

- **Positive.** The four numbers become four facts. A refund cannot exceed money BeauClick holds, and the ledger cannot claim money it never held — both enforced in PostgreSQL, not by convention.
- **Positive.** `OrderPaid v1` never moves, so every existing consumer keeps its exact meaning and full-online behaviour is byte-identical.
- **Negative, disclosed.** A second commerce event and a second order status for consumers to consider. Mitigated by the classification table above, exact-set tests, and CHECK constraints.
- **Negative, disclosed.** `collected_total_toman` duplicates a fact the payment schema already holds in `payment_attempts.verified_amount_toman`. Accepted deliberately: the refund ceiling must be a CHECK on one row, and a cross-schema read cannot be one. The two are written in the same transaction, so they cannot disagree.
- **Negative, disclosed.** The deposit path cannot be exercised through the public API until #83 makes a mode selectable. It is proved at the pipeline level against a planted schedule instead, and this ADR records the gap rather than pretending otherwise.

## What was deliberately not built

- Policy publication, selection, or any way to *choose* a deposit — **#83 (`#41d`)**.
- Booking-credit consumption — **#58 (`#40d`)**.
- Any deposit value, percentage, base, bound, rounding rule, retention amount, no-show penalty, dispute rule, settlement timing or tax treatment — **#46**.
- Real provider collection, credentials, settlement or payout — **#47**.
- Relay version-awareness, `OrderPaid v2`, or any change to the relay's
  event-name dispatch model.
- Any change to `booking`, loyalty, journey or referral behaviour.

## Open gates

- Which collection modes may be enabled — `V33-DEC-011`, open under #46.
- Deposit bounds, rounding values and the percentage calculation base — `V33-DEC-012`, #46.
- Cancellation retention, no-show and dispute outcomes — `V33-DEC-013`, #83, #46.
- The commercial commission **basis** — `V33-DEC-016`, #46.
- Real provider collection and settlement — #47.
