# V3 Phase 2 Implementation — Booking + Commerce + Payment + Financial

Status: **COMPLETE.** Verified against real PostgreSQL 16, with a real API and a real frontend, driven in a real browser.

Baseline: Phase 1 at `b11e5a4`. V2.4.1 (`5fc9c69`) confirmed an ancestor of HEAD and untouched — no file under `wordpress/`, `app/`, or `shared/` was written or deleted in this phase. No `v3.0.0` tag was created; no historical tag moved.

**Totals: 348 automated tests passing** (205 fast-layer, 143 real-PostgreSQL), up from Phase 1's 122. TypeScript strict clean across 16 projects, ESLint (including Nx module boundaries) clean, both builds succeed.

---

## 1. What was built

Four new domain services, two new shared libraries, four new schemas, and the first functional V3 customer flow.

| Module | Owns | Key guarantee |
|---|---|---|
| `services/booking` | availability slots, bookings, holds, history, reschedule | exactly one live booking per slot, three independent enforcement layers |
| `services/commerce` | orders, order items, price adjustments, the pricing engine | one pricing path; one order per booking, by DB constraint |
| `services/payment` | intents, attempts, refunds, provider registry, mock gateway | server-to-server verification; replay-safe by unique constraint |
| `services/financial` | append-only ledger, settlement, session-scoped reads | immutability enforced by PostgreSQL grants, not convention |
| `libs/money` | integer-Toman arithmetic | `part + remainder === total`, always, including negatives |
| `libs/events` | transactional outbox, envelopes, relay | an event cannot commit without its business fact |

---

## 2. Architecture deviations from the Phase 0 corpus

Every deviation below was made because evidence in the actual codebase or the actual database contradicted the blueprint — not for convenience. Each is recorded in an ADR.

### 2.1 Financial isolation: separate ROLE, not separate DATABASE (ADR-017)

`V3_DATABASE_BLUEPRINT.md` §1 specified a physically separate database for `financial`. Phase 2 uses a separate **schema, owner role, and connection** instead.

The isolation goal is met in full and verified: the main application role has `REVOKE ALL ON SCHEMA financial` and **cannot even `SELECT` the ledger**. Because the application role is not the schema owner, it cannot grant itself back what was revoked — a property a separate database owned by the application role would *not* have.

What a separate database would additionally cost is the `booking` + `commerce` transaction, forcing a saga onto a problem with a good ACID answer. Full reasoning in ADR-017.

### 2.2 Booking states: `expired` is first-class

V2 modelled an abandoned hold as `cancelled` with `cancelled_reason='expired'`. That made "did a customer actually cancel on us?" unanswerable without string-matching a free-text column, and made the refund decision depend on that same string. `expired` is now its own terminal state.

### 2.3 Payment states: `requires_action` dropped

ADR-006 sketched a Stripe-shaped lifecycle including `requires_action`. Iranian gateways are redirect-based — the redirect *is* the action, and there is no second interaction step an API can request. Carrying a state no adapter can produce would force every consumer to handle an unreachable branch forever. Adding it later is additive.

### 2.4 Settlements are append-only too

V2 reversed a settlement by `UPDATE`ing its status. That keeps settlement history mutable, so it cannot live under the same revoked-`UPDATE` grant that protects the ledger. A reversal is now a **new row** with mirrored negative items.

Two things fall out: the whole `financial` schema is INSERT-only under one grant policy, and "how much has this party been settled?" becomes a single `SUM` with no status filter to get wrong.

### 2.5 Commission rates in basis points

V2 used integer percent, so 12.5% was unrepresentable. Rates are now basis points (1500 = 15%), still captured per ledger row at write time.

### 2.6 Consistency decided per transition (ADR-018)

ADR-007 chose the transport; nothing said which transitions should be eventual. Phase 2 states the rule explicitly: *if two facts being separately true is a state the product cannot coherently be in, they commit together.* See §6.

### 2.7 Kafka deferred, disclosed

Phase 2 ships the transactional outbox, versioned envelopes, and an idempotent consumer contract — the parts that determine correctness — with an **in-process relay** rather than Kafka. No producer writes to a broker directly and no consumer knows how the envelope arrived, so the swap touches one file. Disclosed as deferred rather than described as done.

---

## 3. Booking and availability

### Availability model

Concrete materialized slot rows, not recurrence rules evaluated at read time — V2's proven choice, kept for a reason that is now explicit: **there is no atomic way to claim a row that does not exist**, and the whole concurrency guarantee rests on exactly that. `bulkGenerate` gives professionals weekly-pattern ergonomics while keeping one real, lockable row per slot.

### The concurrency guarantee, precisely

The claim is a single conditional `UPDATE`:

```sql
UPDATE booking.availability_slots
   SET status='held', held_until=$1, held_by_booking_id=$2
 WHERE id=$3 AND professional_id=$4 AND start_at > now()
   AND (status='open' OR (status='held' AND held_until < now()))
```

Under PostgreSQL's default READ COMMITTED isolation, a second concurrent `UPDATE` of the same row blocks on the first transaction's row lock and, on release, **re-evaluates its `WHERE` clause against the newly committed row**. That re-check is specific to `UPDATE`/`DELETE` and is precisely why the claim is one statement rather than SELECT-then-UPDATE. The loser matches zero rows.

Accepting an **expired** held slot in the same predicate is what keeps availability correct in real time: a customer is blocked only by an *active* hold, never by how recently the sweep ran.

**Three independent layers, not one:**

1. the conditional `UPDATE` (the mechanism);
2. `uq_bookings_active_slot` — a partial `UNIQUE` on `slot_id` restricted to `pending`/`confirmed`, making a second live booking on one slot structurally impossible even if a future code path bypassed the service entirely (**V2 had no such constraint**);
3. `ex_availability_slots_no_overlap` — a GiST exclusion constraint on `(professional_id, tstzrange(start_at, end_at))`, so a professional cannot have two overlapping slots (V2 enforced this with a `SELECT` two concurrent requests both pass).

### State machine

```
                    +-----------> expired      (hold lapsed, never paid)
                    |
  [*] --> pending --+-----------> cancelled    (customer/professional/system)
             |
             v
         confirmed ------------> cancelled
             |
             +------> completed
             |
             +------> no_show
```

Every status write goes through one method that consults a declared transition table **and** compare-and-swaps on the current status in the same `UPDATE`. Two guards on purpose: the table makes an illegal transition a clear domain error; the CAS makes a legal-but-raced transition resolve to exactly one winner.

`transition()` takes an explicit `throw | report` policy. `confirm()` uses `report`, and this is load-bearing: confirmation runs inside the transaction that just recorded a real, verified payment. Throwing there would roll that payment back and **lose a charge that actually happened**.

`rescheduled` is deliberately *not* a state — a reschedule moves a booking while it remains pending/confirmed. It is a history event plus a counter.

### Rescheduling

Structurally a claim-then-move-then-release using the identical atomic claim, introducing no second concurrency primitive. The **new slot is claimed first**, so a failure at any point leaves the original booking intact — a customer is never left without a booking because a race went the wrong way. Unlike V2 it runs in one transaction, so rollback is the database's job rather than a hand-rolled compensating `UPDATE`.

### Timezone handling

Wall-clock ↔ instant conversion is isolated in `platform-time.ts`, implemented against the IANA database via `Intl` rather than a hard-coded +03:30. Iran abolished DST in 2022, so a fixed offset would be correct *today* and would silently produce hour-wrong slots for every affected day if that ever reversed. Weekdays are read in the platform zone, not the server's — a server in UTC would classify a Saturday 00:30 Tehran slot as Friday and generate a whole pattern a day off.

---

## 4. Commerce and the pricing engine

### The problem being solved

V2 had several independent price-modifying systems — membership, campaign, B2B tier — implemented as separate WooCommerce hooks at hand-chosen priorities (10/20/30) across *two* different extension points (an order filter and a cart filter). Whether two could stack, and against what base, was an emergent property of registration order that no single file expressed. `PRODUCT_GAP_REGISTER.md` records the real consequences: a compounding bug, a float-rounding mismatch between two discounts, and an entire pricing path (B2B quote orders) that no discount could reach because it fired no hook.

### The V3 answer

One path. Every rule implements `PricingRule`; `PricingService` evaluates them; the outcome is an explicit, ordered, itemized `PricingResult` persisted alongside the order. There is no second way for a price to change.

Invariants enforced **by the engine**, not trusted to rule authors:

- **Deterministic order** — sorted by `(priority, key)`, never registration order.
- **No compounding** — every rule receives the same *immutable* `subtotalToman`. A rule literally cannot see a discounted base to compute a percentage against. 10% and 15% are both of the same base.
- **Never below zero** — each discount is clamped against what actually remains, in application order.
- **Integer Toman throughout** — all arithmetic through `@beauclick/money`, which throws on a fractional value rather than rounding it away.
- **Reproducible and explainable** — every adjustment is persisted, so a historical total stays explainable after the rules themselves change.
- **A failing rule is fatal** — swallowing a pricing error would charge a price no rule agreed to.

**Phase 2 registers zero rules.** Membership and campaign pricing are later phases; inventing their economics now would pull future scope in. What ships is the single path they plug into, proven by 20 tests that register real rule implementations against it.

### Order integrity

- `uq_orders_source` on `(source_type, source_id)` — **the structural closure of GAP-03**, V2's booking→order double-creation gap that "self-healed only by accident".
- `ck_orders_total_consistent` — `total = subtotal - discount + fee`, so an order whose stored total disagrees with its own line items cannot be persisted.
- `ck_orders_refund_within_total` — an order can never be refunded for more than it was charged, however many concurrent refunds race.
- Line item `name` and `unitPriceToman` are **snapshots**: a later catalogue edit never changes what a past customer was charged.

---

## 5. Payment

### Callback security

The design centre. **A gateway redirect is not evidence** — a user can type the success URL. So:

1. The callback's parameters are used **only to identify** which transaction to ask about.
2. `provider.verify()` makes a **server-to-server** call for the outcome.
3. The gateway's reported amount is compared against the figure the **intent captured before the customer ever left** — so an order total mutated in the meantime cannot launder a mismatch.

Verification is split into `prepareVerification` (network, no writes) and `applyVerification` (writes, caller's transaction), so an HTTP round trip to a bank never holds a database connection and row locks open.

### Idempotency, by database constraint

| Constraint | Prevents |
|---|---|
| `uq_payment_attempts_provider_reference` | a replayed callback resolving to a *different* row — there is exactly one row for the CAS to win |
| `uq_payment_intents_live_order` | double-clicking "pay" opening two intents for one order |
| `uq_payment_attempts_live_per_intent` | two live gateway references per intent (see §5.2) |
| `uq_refunds_order_request_key` | the same cause refunding twice — keys are deterministic per cause, not per call |

The refund row is written **before** the gateway is called. Writing it after would mean a crash mid-call leaves no evidence, and the retry issues a second refund against real money.

### 5.2 The double-charge hole (found in live QA)

Driving the real flow in a real browser exposed a bug no unit test had reason to look for. A retried `POST /v1/bookings` correctly returned the **same** booking and order — idempotency working — but `checkout()` called `initiate()` again unconditionally, producing a **second payment attempt with its own gateway reference**. Two live references for one intent are two separately-chargeable transactions, and the second charge would have been silently absorbed: its callback wins its own attempt CAS, then finds the order already paid and reports a harmless-looking "replayed".

Closed at three levels:

- `initiate()` now **reuses** a live attempt and returns its stored redirect URL — removing the cause;
- `uq_payment_attempts_live_per_intent` makes a second live attempt **unrepresentable**;
- a customer who kept an older redirect URL open can still reach the gateway, so a genuinely-new payment landing on an already-paid order is now detected as a **duplicate charge and refunded**, not absorbed.

That refund carries `kind='duplicate_charge'` and deliberately does **not** flow through to commerce or the ledger. The order was legitimately paid once; recording it as an order refund would drive a correctly-paid order to `refunded` and strip the professional's receivable for a service they are still owed for.

### Paid but unconfirmable

If the hold lapsed while the customer was at the gateway, `confirm()` returns false. The money genuinely moved, so **the payment record must stand** — rolling it back would lose a real charge. The transaction commits and an automatic refund follows, keyed deterministically so a retry cannot refund twice. V2's hardest-won payment rule, preserved exactly.

### Gateway status — GAP-06 REMAINS OPEN

| Layer | Status |
|---|---|
| Provider abstraction (`PaymentProvider` + registry) | ✅ **CODE VERIFIED** — 10 registry tests, fails closed on unknown/disabled/ambiguous |
| Local mock gateway, full loop | ✅ **LOCAL PROVIDER VERIFIED** — 23 security tests + a real browser round trip |
| A real Iranian gateway (ZarinPal or other) | ❌ **NOT VERIFIED — NOT BUILT** |

No merchant credentials exist in this environment. A real adapter was deliberately **not** shipped: its money-unit and field semantics could not be exercised against the live API, and an unverified money-unit assumption in a payment adapter is a liability, not an asset. What Phase 2 delivers is the abstraction that makes such an adapter a drop-in — commerce, booking, financial, and every controller are untouched by adding one.

The mock provider is a **real simulation, not a shortcut**: it keeps its own table and `verify()` genuinely queries it, so a forged success callback fails there for the same structural reason it would against ZarinPal. It **gates itself shut in production**, failing closed — V2 shipped a dev-only Cash-on-Delivery stand-in whose "local development only" status was UI text with no mechanism behind it.

---

## 6. Financial

### GAP-01 — closed structurally

V2 could only ever claim "no mutating method exists in `LedgerService`". Its MySQL hosting lacked the `SUPER` privileges its trigger attempt needed, so the trigger silently failed to install and code-level convention was the only always-true guarantee.

Verified against real PostgreSQL 16:

| Operation | `financial_writer` | `financial_reader` | main app role |
|---|---|---|---|
| INSERT ledger | ✅ | ❌ denied | ❌ denied |
| SELECT ledger | ✅ | ✅ | ❌ **denied** |
| UPDATE ledger | ❌ denied | ❌ denied | ❌ denied |
| DELETE ledger | ❌ denied | — | ❌ denied |
| TRUNCATE ledger | ❌ denied | — | ❌ denied |
| UPDATE settlement tables | ❌ denied | ❌ denied | ❌ denied |
| UPDATE `outbox_events` | ✅ (the one deliberate exception) | ❌ | ❌ |

The writer role is asserted **non-superuser** by the test itself — granting SUPERUSER would make every other assertion pass for the wrong reason. Rows are re-read and verified byte-identical after every denied mutation.

### GAP-05 — closed by type signature

V2's `party_receivable_net($party_type, $party_id)` took the party as caller-supplied arguments; isolation existed only because every real caller happened to resolve its own party first.

V3 does not expose that shape to session-scoped callers at all. **`MyFinanceService`'s methods take a session user id and nothing else** — there is no party argument to spoof, mistype, or forget to validate. The party is resolved internally through a port the composition root implements. Cross-party reads live on a *separate*, capability-gated admin service, so the dangerous shape is never one typo away from the self-service one.

### Preserved from V2 verbatim in shape

- `UNIQUE(entry_type, reference_type, reference_id)` idempotency — the strongest such guarantee found anywhere in V2, confirmed there to have absorbed a real double-fire.
- **Refunds reverse at the ORIGINAL captured rate**, never live config. Tested by changing the platform rate mid-test and asserting the reversal still uses the original.
- Outstanding balance always computed fresh, never cached — and allowed to go **negative** after a post-settlement refund rather than clamped. A negative outstanding is an honest fact about money paid out and then refunded; clamping would hide real money owed back.
- Settlement re-reads each order's outstanding amount *inside* the transaction, immediately before writing. That re-read — not the operator's UI selection, which is advisory — is the real guard against settling twice.

### Settlement

Operator settles specific orders in **full**, at the system-computed amount. Never a free-typed figure an operator could fat-finger into disagreeing with any real financial fact; never a lump sum, which would make per-order traceability impossible. The `CreateSettlementDto` has no `amount` field at all.

---

## 7. Consistency boundaries (ADR-018)

> **The rule:** if two facts being separately true is a state the product cannot coherently be in, they commit together. Otherwise they are eventual.

**Atomic, one transaction:**
- slot claim + booking + history + outbox row
- booking + order creation
- payment verified + order paid + booking confirmed ← *this is where V2 bled*

**Eventual, via outbox:**
- `OrderPaid` → ledger (financial is on a different connection and *cannot* join)
- `RefundCompleted` → commerce → `OrderRefunded` → ledger reversal
- `BookingCancelled` → refund (a bank call must not hold row locks)
- `BookingExpired` → cancel unpaid order

booking-service fires **facts** and never decides financial consequences — V2's separation, kept.

---

## 8. Event catalog delta

Implemented in Phase 2, all versioned, all with an idempotent consumer contract:

`BookingCreated`, `BookingConfirmed`, `BookingCancelled`, `BookingCompleted`, `BookingRescheduled`, `BookingExpired` (new), `OrderCreated`, `OrderPaid`, `OrderCancelled`, `OrderRefunded`, `PaymentInitiated`, `PaymentSucceeded`, `PaymentFailed`, `RefundCompleted`, `LedgerEntriesRecorded`, `SettlementRecorded`, `SettlementReversed`.

**The catalog's hardest rule is now enforced by a throw, not a comment.** Every outbox write scans its payload against a deny-list of credential-shaped keys (`code`, `otp`, `password`, `token`, `refreshToken`, `secret`, `merchantId`, `cardNumber`, …), recursively. A payload carrying one fails at the write, inside the producing transaction. Deliberately an exact-key deny-list rather than a substring heuristic: `providerReference` and `paymentIntentId` are legitimate and necessary fields, and a naive `/token|secret/` rule would reject them and push authors toward disabling the check.

Asserted by a real-database test that scans every payload the checkout flow actually produced.

---

## 9. API surface

All under `/api/v1/`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/providers/:id/availability` | public | Claimable slots only; never leaks `heldUntil` or a booking id |
| GET | `/me/availability` | session | Professional's own; id derived from session |
| POST | `/me/availability/slots` | session | No path param to tamper with |
| POST | `/me/availability/bulk` | session | Bounded; idempotent by DB constraint |
| DELETE | `/me/availability/slots/:id` | session | `open` slots only; a live booking's slot → 409 |
| POST | `/bookings` | session | **Composition root** — booking + order in one transaction; `Idempotency-Key` header |
| GET | `/bookings/:id` | session + party resolver | Customer or professional; stranger gets the same 404 as nonexistent |
| GET | `/bookings/:id/history` | session + party resolver | |
| POST | `/bookings/:id/cancel` | session + party resolver | Actor type re-derived from session, never from the request |
| POST | `/bookings/:id/reschedule` | session + party resolver | |
| POST | `/bookings/:id/complete` | session + **professional** resolver | A customer gets 404 — it is not their call |
| POST | `/bookings/:id/no-show` | session + professional resolver | Only after the slot has ended |
| GET | `/me/bookings`, `/me/professional-bookings` | session | Paginated |
| GET | `/me/orders`, `/orders/:id` | session + owner resolver | Receipt with itemized adjustments |
| GET/POST | `/payments/callback/:provider` | **public** | Gateway return leg; nothing derived from the request |
| POST | `/payments/intents/:id/initiate` | session | Ownership checked against the intent's own customer |
| GET | `/me/finance/summary`, `/outstanding-orders`, `/settlements`, `/orders/:id/ledger` | session | **No party argument exists** |
| GET/POST | `/admin/finance/*` | `bc_manage_platform` | Cross-party, capability-gated |
| POST | `/mock-gateway/:reference/settle` | public, dev-gated | The simulated bank |

---

## 10. Frontend

`/providers` → `/providers/[id]` (service + slot + confirm) → mock gateway → `/checkout/result` (receipt) → `/bookings`.

- **No price is ever sent.** The confirm request carries only ids. `forbidNonWhitelisted` rejects a smuggled `priceToman` outright rather than silently stripping it (verified: 400).
- **One idempotency key per checkout attempt**, reused across retries of that attempt including the API client's post-refresh retry — so a key stays meaningful across a token refresh.
- **Slots grouped by Tehran-local day**, not UTC day. Verified live: 23:00 files under Friday, 00:00 under Saturday.
- Receipt lists **every adjustment individually**, exactly as the pricing engine produced it at order time — never recomputed against today's rules.
- The result page uses the URL's `status` **only to choose a message**; every figure is re-fetched from the API, so editing the query string yields a reassuring headline over a receipt that still tells the truth.

---

## 11. Verification

### Automated

| Gate | Result |
|---|---|
| TypeScript (strict) | ✅ 16/16 projects |
| ESLint incl. Nx module boundaries | ✅ 16/16, verified by deliberate violation in both directions |
| Fast suite (unit + pg-mem) | ✅ **205 passing** |
| Real-PostgreSQL suite | ✅ **143 passing** |
| **Total** | ✅ **348 passing, 0 failing** |
| Build | ✅ `api` + `web` |
| Migrations from zero → re-run | ✅ apply, verify, idempotent skip |

Real-PostgreSQL breakdown: concurrency 10, payment security 23, financial integrity 41, booking lifecycle 37, outbox 6, Phase 1 regression 26.

### Concurrency — real, not simulated

Every case fires genuinely simultaneous operations through separate pooled connections. A sequential pair proves nothing about locking and would pass against an implementation with a wide-open race window.

- ten concurrent customers, one slot → **exactly one winner**, verified in the database
- losers leave **no orphan booking and no orphan history row**
- concurrent confirm ×3 → one transition, **one** `BookingConfirmed` event
- concurrent cancel ×2 → one transition, one event
- hold expiry racing a fresh claim → exactly one live booking
- concurrent identical slot creation → one survivor (exclusion constraint)
- concurrent ledger recording ×3 → one pair of entries
- **simultaneous duplicate payment callbacks** → one `PaymentSucceeded`, one `OrderPaid`

### Live QA — real stack, real browser

Real PostgreSQL + real NestJS API (`:3099`) + real Next.js (`:3100`).

- Booking flow end to end: provider list → service → slot → confirm → gateway → callback → verified → order `paid`, booking `confirmed`, slot `booked`, all 7 outbox events published, ledger recorded 127,500 commission + 722,500 receivable summing exactly to the 850,000 charged.
- Retried `POST /v1/bookings` with the same key → same booking, same order (idempotency live).
- **Responsive**: 375, 390, 412, 1280 — no horizontal overflow, no interactive element under 44px, `dir=rtl` at every width.
- **Persian/RTL/Jalali**: `جمعه، ۳۰ مرداد ۱۴۰۵`, prices `۸۵۰٬۰۰۰ تومان`, times `۱۴:۰۰` LTR-embedded inside RTL.
- **Accessibility**: single `h1` with logical `h2`/`h3`, 14 `aria-pressed` controls announcing selection state, skip link targeting `#main`, labelled inputs, `role="alert"` errors.
- **Authorization**, all live: customer denied the professional surface (404) and financial admin (403); professional A denied cross-party finance (403); professional B cannot read or cancel A's customer's booking (404, **data verified unchanged**); forged and nonexistent ids return byte-identical responses; price smuggling rejected (400); unauthenticated finance (401).

---

## 12. Bugs found and fixed during this phase

All found by writing tests or by driving the real stack — none pre-existing in Phase 1 except where noted.

1. **`failureCode` reported `amount_mismatch` for every failed payment**, including a plain declined card — sending a support engineer hunting a tampering incident that never happened.
2. **`confirm()` threw for an expired booking**, aborting the transaction that had just recorded a real payment. Its own docblock said it must return false. Transitions now take an explicit throw/report policy.
3. **`@Redirect()` routes were incompatible with the global response envelope** — the interceptor wrapped the redirect control object, so the gateway return leg silently degraded to a 302 with no location. Fixed with an explicit `@SkipResponseEnvelope()`.
4. **The double-charge hole** (§5.2) — found in live QA.
5. **Migration runner ordered by schema directory, not timestamp** (Phase 1 code). Adding `booking/` would have applied its migrations before `identity/`'s purely because `'b' < 'i'`.
6. **`financial-role-contract.sql` was never committed** (Phase 1). The root `*.sql` ignore rule swallowed it, so a documented, tested guarantee existed only on the machine that ran it.
7. **Header nav links were 25px tall** (Phase 1), below the 44px baseline the project set for itself. Measured, not eyeballed.
8. **The mock gateway digit-substituted its transaction reference**, mangling an opaque identifier a customer may have to read back to support.
9. **The pg test harness re-registered AppModule's globals**, double-wrapping every response and running each guard twice.
10. **`-0` persisted as a discount total** when no rule applied.

### A material finding about the Phase 1 test layer

**pg-mem does not honour TypeORM's `ROLLBACK`.** A row written inside a transaction that throws survives it — probed directly. Consequence: **no test on that layer can prove anything about atomicity, isolation, or locking.** Since Phase 2's correctness rests almost entirely on those properties, every such assertion runs against real PostgreSQL instead. Documented loudly in `libs/testing` so it cannot be rediscovered the hard way.

---

## 13. Known limitations (disclosed, not worked around)

1. **GAP-06 remains OPEN** — no real gateway adapter. §5.
2. **Kafka is not deployed.** The outbox and envelope discipline are built; the transport is in-process. §2.7.
3. **The financial outbox is not drained.** A relay holds one `DataSource` and financial is on its own. Its events have no Phase 2 consumer; the phase that adds one adds a relay instance.
4. **Grants verified on a local PostgreSQL 16 instance**, not a provisioned production host. Re-run `financial-roles.sql` against real hosting before relying on it.
5. **No business/multi-staff seller party.** `FinancialPartyResolver` returns `professional` only; the type already admits `business`.
6. **Waitlist not built.** `BookingCancelled`/`BookingExpired` are the events a waitlist matcher will consume; nothing else is needed from booking-service.
7. **Pricing rules: zero registered.** Deliberate — §4.
8. **RBAC still code-based**, audit logging still structured-logger-based (both unchanged from Phase 1, both later-phase scope).
9. **No CI pipeline.** Every gate is an `nx` target and CI-ready.
10. **Refresh token still in memory**, so a reload signs the user out. The httpOnly-cookie fix was named Phase 2 scope in Phase 1's doc and was **not** done — booking/commerce/payment/financial consumed the phase. Restated as open rather than quietly dropped.
11. **No screenshots.** The Browser pane cannot composite frames headlessly in this environment, and synthetic clicks time out; live verification used DOM reads, computed-style assertions, and page-driven events instead — stronger evidence for the properties checked, but no image artifacts.

---

## 14. Operational notes

**One-time per environment, before the financial migration:**

```bash
psql -U postgres -d <db> \
  -v owner_password=... -v writer_password=... -v reader_password=... -v db_name=<db> \
  -f v3/database/scripts/financial-roles.sql
```

**Then migrate**, with the financial schema applied by its owner role:

```bash
DATABASE_URL=... MIGRATION_URL_FINANCIAL=postgres://beauclick_financial_owner:...@host/db \
  pnpm migrate
```

`FINANCIAL_DATABASE_URL` (the *writer* role) is mandatory for the API. It refuses to boot without it, and in production additionally refuses to boot if that role is a superuser or holds `UPDATE` on the ledger.

---

## Cross-references

- `ADR-017` — financial isolation boundary and money representation.
- `ADR-018` — cross-domain consistency boundaries.
- `ADR-006`, `ADR-009`, `ADR-011` — the designs this phase implements, with deviations noted in §2.
- `V3_GAP_REGISTER.md` — Phase 2 addendum.
- `V3_EVENT_CATALOG.md` — Phase 2 implementation status.
