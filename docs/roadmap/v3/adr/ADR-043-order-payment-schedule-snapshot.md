# ADR-043 — Every order carries an immutable collection-schedule snapshot, and it changes nothing yet

**Status:** ACCEPTED — 2026-09-05
**Approver:** product owner (`V33-DEC-022` ratified 2026-09-05)
**Backlog:** #41 (`#41a`)
**Depends on:** ADR-039 (commercial policy is a versioned control plane), ADR-027
(subject-data contract), ADR-018 (same-cluster consistency), ADR-017 (financial
isolation), ADR-011 (module boundaries)
**Constrains:** #81 (`#41b`), #82 (`#41c`), #83 (`#41d`)

## Context

`commerce.orders` holds one monetary total. `total_toman` is simultaneously the
full disclosed service price, the amount BeauClick asks the gateway for, and the
amount `OrderPaid` reports as collected — because under the only collection mode
that has ever run, `full_payment_online`, those three numbers are the same.

`V33-DEC-003` closed the vocabulary for three modes, and ADR-039 §3 stated the
consequence plainly: *"The full service price, the amount collectible by
BeauClick and the venue balance are different facts. A client must never infer
one from another."* `packages/commercial-policy-contract` implements exactly
that, including `collectionBreakdownV1()` with BigInt floor division, min/max
guards and a service-total clamp.

The Story #41 readiness audit of 2026-09-05 found the gap is not vocabulary but
**persistence and reachability**: `CommercialPolicyModule` is composed into no
`apps/api` module, so none of the contract is reachable from the running
application, and no table can hold the three amounts apart.

`V33-DEC-022` decomposed #41 into four children and made this one — `#41a` — a
**compatibility-preserving foundation**. `V33-DEC-011` still controls which modes
may be *enabled* and is open under #46, so this ADR must produce a structure that
can represent every mode while activating none.

## Decision

### 1. One dedicated table, one-to-one with the order

`commerce.order_payment_schedules`, primary key `order_id`, a real foreign key
to `commerce.orders (id)`.

The primary key **is** the one-to-one guarantee and the idempotency arbiter; no
separate unique index exists to drift from it.

Rejected alternatives, and why each fails a requirement rather than merely
losing a preference:

- **Columns on `commerce.orders`.** That table legitimately mutates `status`,
  `refunded_total_toman`, `paid_at` and `updated_at`. An immutability trigger
  would need an exemption list, so "the snapshot is immutable" would be a
  comment rather than a database property — and the exemption list is exactly
  where a later column becomes silently mutable.
- **Order adjustments.** `commerce.order_adjustments` is a pricing *history*
  with its own `kind`, `rule_key` and sort semantics. A collection schedule is
  not an adjustment to a price; ADR-039 §3 is explicit that a deposit is an
  allocation of the price, never a discount or fee.
- **Payment-intent metadata.** Mutable JSON, carries no CHECK constraint, and
  ties a fact about the ORDER to a row that may be superseded by a retry.

### 2. The vocabulary is the contract's, and the SQL says so

No parallel enum and no second arithmetic implementation
(`V33-DEC-022` Ruling 2). The SQL column names are the snake_case translation of
the contract's own field names, recorded here so the mapping is auditable rather
than inferred:

| Contract (`CollectionBreakdownV1` / `BookingCommercialPolicySnapshotV1`) | Column |
|---|---|
| `BookingCollectionMode` | `collection_mode` |
| `serviceTotalToman` | `service_total_toman` |
| `platformCollectibleToman` | `platform_collectible_toman` |
| `venueBalanceToman` | `venue_balance_toman` |
| `policyKey` | `policy_key` |
| `policyVersion` | `policy_version` |
| `acceptedAt` | `policy_accepted_at` |

`contract_version` records which contract version wrote the row, so a future
`V2` breakdown is a new value rather than a reinterpretation of old rows.

### 3. Every invariant is a database constraint, not a service check

A service check cannot survive a psql session, a future writer, or a migration.
So the arithmetic lives in PostgreSQL:

```
ck_ops_amounts_non_negative   all three amounts >= 0
ck_ops_sum                    platform_collectible + venue_balance = service_total
ck_ops_mode_consistent        full_payment_online              -> collectible = total AND balance = 0
                              pay_at_venue                     -> collectible = 0     AND balance = total
                              deposit_online_balance_at_venue  -> 0 < collectible < total
ck_ops_policy_reference       key, version and accepted_at are all present or all absent
ck_ops_contract_version       contract_version >= 1
```

`ck_ops_sum` and `ck_ops_mode_consistent` overlap deliberately: the sum rule
alone permits `pay_at_venue` with a non-zero collectible, and the mode rule alone
permits a deposit whose parts do not add up.

**Deposit mode requires `0 < collectible < total`, strictly.** A "deposit" equal
to the total is `full_payment_online` and a "deposit" of zero is `pay_at_venue`;
allowing either here would create two truthful spellings of one fact and make
"which mode was this?" ambiguous at the row level.

### 4. Immutability is a trigger, and the table earns it

`BEFORE UPDATE OR DELETE → RAISE`, the same shape
`commercial.reject_grant_rewrite()` uses for booking-credit grants.

Unlike `commerce.orders`, this table has **no legitimately mutable column**, so
the trigger needs no exemption and the guarantee is unconditional. A schedule is
what was agreed when the order was created; changing it later would rewrite a
receipt.

The order it describes still mutates freely — `status`, `refunded_total_toman`,
`paid_at` are untouched by this ADR. Immutability is a property of the snapshot,
not of the order.

### 5. Creation is inside the order's own transaction

The insert joins `OrderService.createForBookingWithin`'s existing
`EntityManager`, beside the order row, the item, the adjustments and the
`OrderCreated` outbox row.

There is therefore no window in which an order exists without its schedule, and
a failure anywhere in that transaction leaves neither. This is available because
both tables are in the same cluster (ADR-018); an event would have manufactured
a window that does not need to exist.

Concurrency is arbitrated where it already is: `createForBooking` catches the
unique violation on `(source_type, source_id)` and returns the committed
winner's detail, which now includes the winner's schedule. One booking, one
order, one schedule.

### 6. A missing schedule is an integrity failure, never a reconstruction

`loadDetail` fetches the schedule with the items and the adjustments — three
bounded queries by order id, still no per-order loop — and **fails** when it is
absent.

Reconstructing one from `orders.total_toman` would be the most dangerous
available behaviour: `total_toman` is mutable in meaning across this story's
successors, so a reconstructed schedule would silently start describing
something else the day `#41c` changes what the total means. An integrity error
is loud, and after the backfill the condition cannot arise.

### 7. The backfill is a statement about history, not a default

Every existing order receives `full_payment_online`, service total = platform
collectible = `orders.total_toman`, venue balance `0`, and **no policy
reference** — all three policy columns NULL, which `ck_ops_policy_reference`
permits explicitly.

That absence is the truth: those orders were placed before any policy existed to
select. Fabricating a key, a version or an acceptance timestamp would put a
policy on a receipt that never had one.

The migration verifies its own arithmetic afterwards and **fails loudly** rather
than leaving a partial or dishonest backfill.

### 8. The browser gets the server's numbers, and never a calculation

One additive field, `paymentSchedule`, on the existing `toOrderDetail`
projection — which is the *only* receipt projection in the codebase, used by both
`GET /v1/orders/:id` and the booking-creation response.

Every existing field keeps its name and meaning. `totalToman` still reports the
same number it reports today, so a full-online receipt is unchanged. The client
displays `serviceTotalToman`, `platformCollectibleNowToman` and
`venueBalanceToman` **as served**; it never derives one from another, because a
client that can compute the split can compute it wrongly.

### 9. `CommercialPolicyModule` is composed with zero definitions

`CommercialPolicyModule.register([])` at the API composition root.

This is what makes ADR-039's control plane reachable at all — and it activates
nothing: an empty registry resolves no policy, `readiness()` still reports
`productionAvailable: false`, and **commerce does not query it in `#41a`**. The
composition exists so `#41d` extends a wired module rather than introducing one.

### 10. Privacy: `retained`, and the reason is the obligation

`commerce.order_payment_schedules` is claimed `retained` in
`CommerceSubjectDataContract`, exactly as `commerce.orders` is.

It carries no `_user_id` column, and that is **not** grounds for
`no_subject_data`: the row is part of an immutable transaction record reachable
through a retained order, and a subject's exported receipt is incomplete without
the amounts it actually agreed to. It is exported with the order and retained on
erasure for the same commercial-record obligation.

Boot coverage (`SubjectDataCoverageService`) refuses to start when the table is
unclaimed, so the classification cannot be forgotten.

## Consequences

- **Positive.** The three amounts become separable facts with database-enforced
  arithmetic, before any code depends on the separation. `#41b`, `#41c` and
  `#41d` each build on a snapshot that already exists for every order.
- **Positive.** ADR-039's contract finally has a consumer, and the wiring is
  provably inert.
- **Negative, disclosed.** Order creation gains one INSERT and order detail one
  SELECT. Both are keyed by `order_id` and neither is in a loop.
- **Negative, disclosed.** The three-amount fields are visible in the API before
  any mode can produce interesting values, so every response for the
  foreseeable future shows `venueBalanceToman: 0`. That is honest rather than
  premature: the field exists because the fact exists, and hiding it until it
  varies would mean changing the contract twice.
- **Negative, disclosed.** There is **no seller receipt surface in this
  codebase** — no seller-facing order or receipt route exists at all. #41's
  acceptance criteria mention one; `V33-DEC-022` did not ratify a new public
  route, so this story does not invent one. See *Open gates*.

## What was deliberately not built

- Zero-collectible confirmation, and any path that confirms a booking without a
  gateway callback — **#81 (`#41b`)**, which must also carry #58's mandatory
  seam.
- Deposit execution, the refund ceiling correction and the ledger amount
  correction — **#82 (`#41c`)**.
- Policy publication, selection, activation windows and the admin surface —
  **#83 (`#41d`)**, blocked by `V33-DEC-011`/`V33-DEC-012`.
- Any deposit value, percentage base, rounding value, default, minimum, maximum
  or seller choice. `V33-DEC-022` Ruling 3 forbids all of them here.
- Any change to `OrderStatus`, `OrderPaid`, `OrderCreated`, `OrderRefunded`,
  `totalToman`, refunds, ledger entries, payment-intent semantics or booking
  confirmation.

## Open gates

- **A seller receipt surface does not exist and is not created here.** The only
  order-facing routes are `GET /v1/orders/:id` (customer, ownership-guarded) and
  the booking-creation response. Adding a seller-facing receipt is a new public
  route and a product decision; `V33-DEC-022` ratified additive *fields*, not a
  new surface. It needs its own ruling, and it is recorded rather than
  improvised.
- Which collection modes may be enabled — `V33-DEC-011`.
- Deposit bounds, rounding values, and the percentage calculation base, which
  the readiness audit found ratified in no document — `V33-DEC-012` and #46.
- The `OrderPaid` and financial meaning of a partial capture — `#41c`.
- Real provider collection and settlement — #47.
