# ADR-052 — Seller money is recorded as balanced append-only journal facts moving pending → available → settled; commission is a snapshotted administrator policy recognised at the outcome; release, settlement, reserve and receivable recovery fail closed

**Status:** ACCEPTED — 2026-09-15
**Approver:** product owner, under the owner's standing delegation. The 2026-09-15 approval covers four things: the eight-child decomposition of #43, the technical correction of `V33-DEC-040` R6's exact-sum formula, the interpretations A1–A9, and conservative answers to OC-1, OC-2 and OC-3. Everything is recorded as [`V33-DEC-044`](../../v3.3/V3.3_DECISION_REGISTER.md). **This is not lawyer, accountant, tax-adviser or payment-provider approval, and it authorizes no real-money activation.**
**Drafted by:** engineering, from the read-only readiness audit of #43 (2026-09-15, against `b71f10cbb524e687243f53b5b63812eee80ae9a8`) and an independent critical review of that audit. The review history is PR #171.
**Backlog:** #43 (`#43a`) and its children `#43b`–`#43h`, plus `#42f`. `V33-DEC-044` creates `#42f`: a completed booking's valid completion fact and its dispute eligibility.
**Binding authorities (already ratified; none reopened):** [`V33-DEC-040`](../../v3.3/V3.3_DECISION_REGISTER.md) R1–R8 (owner commission, fee-allocation, revenue-recognition, settlement-release and reserve policy). [`V33-DEC-041`](../../v3.3/V3.3_DECISION_REGISTER.md) R1 (provider-held money released by outcome; the financial ledger stays the authoritative record of allocation facts). [`V33-DEC-039`](../../v3.3/V3.3_DECISION_REGISTER.md) R3, R9, R10 and R14. [`V33-DEC-028`](../../v3.3/V3.3_DECISION_REGISTER.md) Rulings 2–5, 8, 9 and 13. [`V33-DEC-024`](../../v3.3/V3.3_DECISION_REGISTER.md) Rulings 3–4. [`V33-DEC-025`](../../v3.3/V3.3_DECISION_REGISTER.md) R7. [`V33-DEC-042`](../../v3.3/V3.3_DECISION_REGISTER.md) R1.
**Supersedes in part:** [ADR-009](ADR-009-financial-ledger.md) decision 1 — its rule that a settlement outstanding "can legitimately go negative", and its rejection of double-entry bookkeeping.
**Depends on:**
- [ADR-017](ADR-017-financial-isolation-and-money.md) — separate financial role and DataSource.
- [ADR-018](ADR-018-cross-domain-consistency.md) — eventual consistency across the DataSource boundary.
- [ADR-025](ADR-025-financial-outbox-consumer.md) — the financial outbox relay.
- [ADR-027](ADR-027-subject-data-contract.md) — subject-data coverage.
- [ADR-039](ADR-039-commercial-policy-control-plane.md) — Booking emits facts, Commercial Policy decides, Payment executes.
- [ADR-045](ADR-045-deposit-capture-collected-accounting.md) — collected money only.
- [ADR-048](ADR-048-booking-collection-policy-publication-and-assignment.md) — publication family pattern.
- [ADR-049](ADR-049-business-classification-locations-resources-and-scoped-staff-authority.md) §5 — `finance_read`.
- [ADR-051](ADR-051-versioned-booking-outcome-policy-and-dispute-model.md) — outcome decisions, no-show declarations, dispute cases.

**Scope of this record.** It writes no schema, migration, route, DTO, service, contract, event, capability, index, seed or test. It publishes no commission rate, fee allocation, schedule, reserve, minimum payout or risk class. It selects no provider and moves no money. It is **not** accounting, tax, Legal or payment-provider approval, and claims none.

**Owner decisions recorded by `V33-DEC-044` and applied here:**
- **OC-1** — release of a plain completed booking (§6).
- **OC-2** — commission on a seller-retained amount (§3).
- **OC-3** — provider fees on a completed booking (§10).

**Still open, and a prerequisite of any real-money rollout:** a separate **legacy disposition** of orders that have no outcome-terms snapshot (§6, §17). Until it is recorded, those orders stay `pending`. That is fail-closed, not forfeiture.

---

## Context

### What the owner ratified

`V33-DEC-040` (2026-09-12) decided, as owner product policy:

- **R1** — commission is a versioned administrator policy of four closed shapes (`percentage(bp, base)`, `fixed(toman)`, `hybrid(fixed_toman, bp, base)`, `zero`) with a required base; `zero` published first; the in-code 1500 bp rate removed.
- **R2** — gateway, refund and reversal fees are facts, allocated between BeauClick and the seller by the cancellation cause, never borne by the customer.
- **R3** — revenue is recognised by type at the earning event; seller money is never BeauClick revenue.
- **R4** — collected seller money is `pending` until a completion event **and** a closed objection window with no open dispute; then `available`; then settled on an administrator-published schedule by plan and risk class, weekly initially.
- **R5** — reserve first, then future earnings, then a manual claim, for any post-settlement shortfall; no negative balance; a post-settlement refund is never refused.
- **R6** — exact integer arithmetic and an exact-sum reconciliation.
- **R7** — privileged, audited batches, reversal and retry.
- **R8** — fail closed everywhere.

### What the repository does today (observed at `b71f10c`, not obligation)

| Observed behaviour | Where |
|---|---|
| The commission rate is `FINANCIAL_COMMISSION_RATE_BP` when it parses as an integer, otherwise `1500` | `v3/services/financial/src/financial.config.ts:24-35` |
| Capture posts a `commission` + `receivable` pair on the collected amount; the split uses float multiplication and round-half-away-from-zero | `v3/services/financial/src/ledger.service.ts:67-127`; `v3/libs/money/src/money.ts:82-103, 134-139` |
| Refunds post negative pairs at the original rate. Two partial refunds (50 + 51 of 101 at 1500 bp) reverse 16 of 15 commission, leaving −1 commission and +1 receivable after a full refund | `ledger.service.ts:145-218` |
| `financial.ledger_entries` allows only `entry_type IN ('commission','receivable')` and `reference_type IN ('order_payment','order_refund')`; `commission_rate_bp INT NOT NULL`; sign bound to reference type; `UNIQUE (entry_type, reference_type, reference_id)` | `v3/database/migrations/financial/20260820100004_create_financial_schema.sql:23-68` |
| The financial writer role holds INSERT + SELECT only; the application role cannot read `financial` | same file `:154-178`; ADR-017 |
| One administrator route settles any selected order immediately and in full. The outstanding amount is read through `this.dataSource.query`, outside the insert transaction, with no lock and no cumulative database bound (a double-settlement race found by reading, not executed) | `v3/services/financial/src/settlement.service.ts:113-133, 200-276`; `financial.controller.ts:282-314` |
| Outstanding may go negative after a post-settlement refund, pinned by a test | `settlement.service.ts:69-78`; `v3/apps/api/test/financial-integrity.pg-spec.ts:437` |
| Settlement audit is detached (`transactional: false`) because the financial DataSource cannot share a transaction with `admin.admin_audit_log`; the batch row is the authoritative record | `financial.controller.ts:283-287, 316-321`; `v3/apps/api/test/operability-foundation.pg-spec.ts:139` |
| The settlement creation reason (`note`) is optional; only reversal requires a reason | `v3/services/financial/src/dto/settlement.dto.ts:41-50` |
| `BookingService.complete()` has no slot-time guard and stamps `completed_at` and the `BookingCompleted` payload from the application clock. The `booking_history` row carries `created_at DEFAULT now()` (database clock) | `v3/services/booking/src/booking/booking.service.ts:443-465`; `v3/database/migrations/booking/20260820100001_create_booking_schema.sql:82, 111-123` |
| No pending, available, disputed, reserve, seller-owes-platform receivable or provider-fee fact exists anywhere | grep of `v3/database/migrations` and `v3/services` |
| Publication families accept a publication instant within ±1 minute of `now()` | `v3/database/migrations/commercial/20260906950001_create_booking_collection_policies.sql:499-500` |

### Why this record exists

`V33-DEC-040`'s implementation gate requires the next ADR, committed alone before any schema or code. It must record R1–R8 verbatim, the policy-family schema, the pending-funds state machine and release predicate, the receivable model, the exact-sum constraint and the ADR-027 dispositions. The readiness audit also found that R6's written identity is arithmetically false (§12), and that three places in the ratified text do not determine one behaviour (OC-1, OC-2, OC-3). This record fixes the mechanisms and applies the owner's answers to those three gaps as recorded by `V33-DEC-044`.

### `V33-DEC-040` R1–R8, as ratified (verbatim)

Copied byte-for-byte from `docs/roadmap/v3.3/V3.3_DECISION_REGISTER.md` lines 5463–5583 at `b71f10c`.

#### R1 — the commission rule engine, and zero as the first published value (Q18)

- A commission policy is a versioned administrator policy whose rule has one of exactly four
  closed shapes: `percentage(bp, base)` · `fixed(toman)` · `hybrid(fixed_toman, bp, base)` ·
  `zero`. **`zero` is an explicit published value, not an absent one** — with it published, a
  commission-bearing ledger write records a zero commission fact; with nothing published, the
  write **fails closed** (`V33-DEC-028` Ruling 3).
- `base` is required policy data over the closed vocabulary `{ platform_collected_amount,
  service_total }` with **no default**, mirroring `V33-DEC-029` Ruling 4. Percentages are integer
  basis points; arithmetic is BigInt floor division in integer toman; no floating point.
- **The deduction ceiling is the money BeauClick collected** (`V33-DEC-001`, #43's acceptance
  criterion "cannot exceed collected funds"). A commission computed on `service_total` that exceeds
  the platform-collected amount is **not** deducted beyond collected funds: the excess becomes a
  **seller receivable** recovered only in the R5 order (reserve → future earnings → manual claim)
  and is **never** a customer charge and never presented as authoritative revenue before recovery.
- **Owner-endorsed initial value: `zero` for booking commission.** `FinancialConfig.DEFAULT_COMMISSION_RATE_BP`
  and `FINANCIAL_COMMISSION_RATE_BP` are removed (already #43's criterion); no `1500` survives
  anywhere. Existing ledger rows keep their snapshotted rate, byte-for-byte.
- The engine, the closed shapes and the base vocabulary are the same for the **acquisition** and
  **processing-recovery** components `V33-DEC-016` lists; each is its own policy family with its own
  `zero`.

#### R2 — refund and gateway cost allocation by cause (Q17)

- Gateway collection fees, refund fees and reversal fees are **costs of the money path**, recorded
  per order as facts when the rail reports them (until a rail exists they are unknown and **no
  amount is invented**).
- **The customer never bears them**, in any cause: a refund returns the collected amount the
  outcome grants, undiminished by fees.
- Between BeauClick and the seller the allocation follows the **cause** recorded by
  `V33-DEC-039` R3: `customer_timely` and `force_majeure` → BeauClick; `customer_late` and
  `no_show` → the seller (bounded by what the seller retained, never more); `seller` → the seller;
  `platform` and `provider` → BeauClick. The mapping is an administrator-published **allocation
  policy** of the `V33-DEC-028` shape whose initial publication the owner endorses exactly as
  stated; the code carries no mapping.
- A seller-borne fee is recovered in the R5 order and is never a negative available balance.

#### R3 — revenue recognition facts by revenue type (Q19)

- The platform records the **event** at which each revenue type is earned, so that recognition is a
  reading of facts, not a re-computation: **subscription** — at the start of each covered term (the
  plan version's term, once published); **booking-credit purchase** — at **consumption** of each
  credit, with unconsumed purchased credit carried as a **customer-of-the-seller liability**, never
  earned revenue (`V33-DEC-041` R6 makes it refundable); **commission, acquisition and processing
  recovery** — at the **completion event** of the booking that bears them (R4), never at collection
  or at booking; **retained late-cancellation / no-show amounts** — they are the **seller's**
  money, not BeauClick revenue, except for BeauClick's published commission share on them.
- **Seller money is never BeauClick revenue** and is never labelled so on any surface
  (`V33-DEC-042` R1 and R3 make BeauClick an intermediary).
- Recognition is **by revenue type**; no aggregate "revenue" figure that mixes seller funds with
  BeauClick's own is produced.
- This is an **owner accounting policy for how the ledger records facts**. The financial statements
  built on it, tax treatment and invoicing require the qualified accountant's and tax adviser's
  evidence recorded by the project before any figure is labelled recognised revenue in production
  reporting (*External activation boundary*).

#### R4 — pending → available → settled: explicit events, then a schedule (Q20)

- Platform-collected seller money enters **`pending`** at collection.
- It becomes **`available`** only when **both** hold: (a) an explicit **service-completion event**
  (`BookingCompleted`, or a retention decision under `V33-DEC-039` R5/R6 in the seller's favour)
  **and** (b) the **objection window of `V33-DEC-039` R9 has closed with no open dispute**. An open
  dispute moves exactly the disputed amount to **`disputed`** (`V33-DEC-039` R10) and back to
  `pending`/`available` or to `refunded` on the outcome. **Passage of time alone never releases
  money**; a completion event without a closed window, or a closed window without a completion
  event, releases nothing.
- **Settlement** of `available` money to the seller follows an administrator-published **schedule
  policy** that may vary by **plan and by a closed risk class** (`standard | elevated`, assigned by
  an administrator with a reason and audit, never inferred). **Owner-endorsed initial value:
  weekly.** Minimum-payout and per-seller reserve percentage are values of the same policy family,
  **unpublished** until an administrator publishes them.
- A settlement is an explicit, audited, append-only transition (already the shape of
  `settlement_batches`), computed from `available` facts at the database clock instant of the
  batch; it never re-reads live policy for historical facts.
- Execution of a settlement against a real bank or provider is #47 / the V3.2-F rail; this card
  decides **when** money is releasable, not the rail.

#### R5 — reserve first, future earnings second, manual claim last (Q21)

- A **reserve** is a per-seller held fraction of `available` money whose percentage and cap are an
  administrator-published value (initially unpublished ⇒ reserve = 0). It is **never negative**
  (`V33-DEC-015`).
- When a refund, reversal, dispute outcome or seller-borne fee (R2) must be funded **after** the
  related money was settled, the shortfall becomes a **seller receivable** — an append-only fact
  with the exact amount and the causing decision — recovered strictly in this order: (1) from the
  seller's **reserve**; (2) from the seller's **future `available` earnings** before any later
  settlement; (3) by a **manual claim** recorded by an administrator with a reason and audit trail.
- **No `available` or `settled` balance ever goes negative**; the receivable is a separate fact,
  visible to the seller in its finance workspace as such. BeauClick does **not** absorb the loss by
  policy (A rejected), and a post-settlement refund is **never refused** on the ground that
  settlement already happened (D rejected).
- A receivable never reduces the customer's refund and is never charged to any customer.

#### R6 — rounding, arithmetic and reconciliation

All money is integer toman; percentages are integer basis points; every division floors
(BigInt); every allocation of one collected amount across commission, fees, retention, reserve
and seller share sums **exactly** to the collected amount, enforced by a database CHECK or
trigger, never by application arithmetic alone. Every fact carries the policy key and version it
was computed under. Reconciliation is a **read**: for each order, `collected = refunded +
retained_seller + commission + fees_platform + fees_seller + pending + available + settled +
disputed − receivable_recovered`, provable by a real-PostgreSQL exact-sum test. A rail's own
reconciliation file, when one exists, is compared against these facts and a mismatch is an
exception queue item, never an automatic correction.

#### R7 — operator approval, failure and retry

Settlement batch creation remains a **privileged, live-revoked, audited** operator action with a
mandatory reason (the existing shape). A batch that a rail later reports failed is **reversed** as
an append-only counter-entry (`reversesSettlementId`, existing) and its items return to
`available`; a retry is a new batch. No batch is silently re-sent. Maker-checker on batch approval
remains the deferred named future decision of `V33-DEC-028` Ruling 13.

#### R8 — fail-closed everywhere

With no published commission policy: no commission-bearing write. With no published allocation
policy: fees are recorded as unallocated facts and **no** deduction is taken from anyone. With no
published schedule policy: money reaches `available` under R4 and **no settlement batch is
proposable**; the administrator's manual settlement route refuses until a schedule policy exists,
because "immediately, in full" is a schedule the owner rejected. With no published reserve value:
reserve = 0. Nothing here changes the customer-facing refund behaviour of today.

*The R6 identity above is kept verbatim as superseded history. §12 shows why it cannot hold as written. §12's identities supersede it as the engineering expression of R6's intent — exact sums, integer arithmetic, database enforcement, reconciliation as a read. That intent is unchanged.*

---

## Decision

Each section separates **obligation** from **rejected alternatives**. Table and column names are binding shapes; a story may add a column a section does not forbid.

Every rule below is classified:
- **[T]** — a technical repair of a contradiction.
- **[A]** — an interpretation of ratified text, approved with `V33-DEC-044`.
- **[OC]** — an owner answer recorded by `V33-DEC-044`.

### 1. Policy-family persistence

**Obligation.** Families live in `commercial`, on the application DataSource. A family's `draft → published → retired` lifecycle needs UPDATE, which the INSERT-only financial role cannot hold **[T]**.

- `commercial.commission_policies` / `_versions` — one stable key per component (`booking_commission`, `acquisition`, `processing_recovery`). The rule columns are `rule_kind IN ('zero','percentage','fixed','hybrid')`, `bp 0..10000`, `fixed_toman > 0` (≥ 0 inside `hybrid`) and `base IN ('platform_collected_amount','service_total')`, with CHECKs pairing each shape to exactly its fields. `base` has **no DEFAULT**. `zero` is a published row; absence is no active version.
- `commercial.fee_allocation_policies` / `_versions` with rows `(version_id, cause_key, fee_kind IN ('collection','refund','reversal'), bearer IN ('platform','seller'))`. An unpublished `(cause_key, fee_kind)` pair is unallocated (§10).
- `commercial.settlement_schedule_policies` / `_versions`, keyed by `(plan_key, risk_class)`: `settlement_interval_days > 0`, `minimum_payout_toman >= 0 NULL`, `reserve_bp 0..10000 NULL`, `reserve_cap_toman >= 0 NULL`.
- `commercial.seller_risk_class_assignments` — `risk_class IN ('standard','elevated')`, `reason NOT NULL`, one current row per seller party, forward-only supersession.
- Every family reuses ADR-048's lifecycle, GiST window exclusion, `bc_manage_commercial_plans` (privileged, live-revoked), a mandatory reason and a same-transaction admin audit row. One stricter rule applies: `published_at` must equal the transaction `now()` and `activation_starts_at >= published_at`, **with no tolerance** **[T]** — see §2's rejection.
- **No seed, migration value, environment variable or code constant.** A repository scan test proves that no commission literal or `FINANCIAL_COMMISSION_RATE_BP` survives.

**Rejected.** *Families in `financial`* — needs an UPDATE grant on the append-only schema. *One family holding commission, fees and schedule* — each changes on a different cadence and review. *A default risk class* — `V33-DEC-040` R4 "never inferred".

### 2. Commission snapshot at commitment **[A1]**

**Obligation.** `commerce.order_commission_terms (order_id, component, state IN ('absent','zero','rule'), policy_key, policy_version, rule_kind, bp, fixed_toman, base, arithmetic_version, resolved_at DEFAULT now(), PRIMARY KEY (order_id, component))`.

- It is written inside the **checkout transaction** for every new order and every component. It reads the active committed version under `FOR SHARE` through a Commerce-owned port (ADR-048 §1).
- It is append-only by trigger. `absent` is written explicitly.
- An order created before this table exists has no rows and is treated as `absent` by every reader. Commission is **computed** later, at recognition (§3), from these values — never from live policy (`V33-DEC-028` Ruling 4).

**Rejected.** *Resolve the version "as of" the order or collection instant when the ledger handler runs.* It is not deterministic: a publication stamped `now() = T0` that commits at T0+5 s is invisible to a handler running at T0+2 and visible at T0+6, and the ±1-minute tolerance makes it worse. *Snapshot at collection instead of order creation* — that would let a rate published between booking and capture reach a booking the seller accepted earlier.

### 3. Commission arithmetic, ceiling and the retained-amount rule

**Obligation [T].**
- Per component, with `base_value` as defined below: `zero → 0`; `percentage → floor(base_value × bp / 10000)`; `fixed → fixed_toman`; `hybrid → fixed_toman + floor(base_value × bp / 10000)`, all in BigInt.
- Components are evaluated in the fixed order `booking_commission, acquisition, processing_recovery`, and `k = Σ`.
- A refunded amount is never deductible, because R2 keeps the refund undiminished.

**Completion outcome (R1 as ratified).**
- `base_value` is `commerce.orders.collected_total_toman` for `platform_collected_amount` and `commerce.orders.total_toman` for `service_total`.
- `held` = seller-attributable money still recorded for the order at recognition, and `deductible = min(k, held)`, allocated in the component order.
- `excess = k − deductible` becomes a seller receivable with cause `commission_excess` — R1's own mechanism, never revenue before recovery.

**Seller-retained cancellation or no-show outcome [OC-2, decided by `V33-DEC-044`].**
- R3 gives BeauClick "its published commission share **on**" retained amounts.
- For every component, whatever its `base` kind, `base_value` is the **retained amount** (`retained_toman` of the outcome decision).
- The total deduction is capped at `min(k, retained_toman)`.
- **No receivable is ever created from a cancellation or no-show outcome**; any computed amount above the cap is simply not charged.
- Example: collected 100, refunded 60, retained 40, 10% commission ⇒ deduction 4; with `fixed 50` ⇒ deduction 40 and no receivable.

**Legacy arithmetic [T].** An order whose collection is a `financial.ledger_entries` row stays on that ledger for life (§16). Its later refunds reverse there at the original rate. The reversal amount is computed **cumulatively**: the commission share of the remaining net amount, minus what was already reversed. No residue survives a full refund, and no existing row changes.

### 4. The journal

**Obligation [T].**

`financial.fund_journals`:
- Columns: `id`, `kind`, `idempotency_key UNIQUE`, `source_type`, `source_id`, the policy snapshot by value, `created_at DEFAULT now()`.
- `kind IN ('collection','refund','dispute_hold','dispute_outcome','release','reserve_hold','reserve_release','settlement','settlement_reversal','recovery','fee')`.

`financial.fund_postings`:
- Columns: `id`, `journal_id`, `order_id`, `seller_party_type`, `seller_party_id`, `account`, `component NULL`, `amount_toman <> 0` signed by the account's normal side, `seq`, `balance_after`, with `UNIQUE (order_id, account, component, seq)`.
- Debit-normal accounts: `pending`, `disputed`, `available`, `reserve`, `settled`, `refunded`, `platform_earned`, `provider_fee`, `recovery_out`.
- Credit-normal accounts: `collected`, `platform_advance`, `recovered_in`.

Database enforcement:
- A BEFORE INSERT trigger requires `seq = previous + 1` and `balance_after = previous balance + amount`. `CHECK (balance_after >= 0)` holds on every account.
- A **DEFERRABLE INITIALLY DEFERRED constraint trigger** refuses any journal whose postings for any one order do not sum to zero. A `recovery` journal must also have `Σ recovered_in = Σ recovery_out`.
- A trigger refuses a posting whose seller party differs from the order's first `collection` posting. The beneficiary comes from `commerce.orders.seller_party_*` through the capture event, never from a request (`V33-DEC-025` R7).

Grants: writer INSERT + SELECT; no UPDATE, DELETE or TRUNCATE; the application role has none.

**Serialization [T].** PostgreSQL requires UPDATE privilege for `SELECT … FOR UPDATE/SHARE`, so the INSERT-only writer cannot row-lock. Every journal insert therefore holds a transaction-scoped **advisory lock** per order (namespace `fjo`). Settlement and recovery hold a per-seller lock (`fjs`) first, then order locks in ascending id order. The `seq` uniqueness makes a missed lock fail loudly instead of forking a chain. The privilege rule is a documentary claim; `#43a`'s preflight must prove it against the real server.

**Rejected.** *Widen `financial.ledger_entries`* — `commission_rate_bp NOT NULL` cannot truthfully snapshot `fixed`, `hybrid`, `zero` or absent; one commission row per payment cannot carry three components; and altering CHECKs on a legally retained append-only table is riskier than adding one. *Single-entry state rows* — an exact sum across states can then only be checked by application arithmetic, which R6 forbids. *A mutable balance table* — needs UPDATE on `financial`.

### 5. Pending-funds state machine

| Journal kind | Guard | Postings (per order) |
|---|---|---|
| `collection` | verified capture event (`OrderPaid v1` / `OrderCollectionCaptured v1`); key `collection:<intent_id>` | `pending +c` / `collected −c` |
| `refund` | `OrderRefunded v1`; key `refund:<refund_id>`; draws `pending`, then `available`; beyond both (already settled) → `platform_advance` plus a receivable (§9) | `refunded +r` / `pending −x`, `available −y`, `platform_advance −z` |
| `dispute_hold` | an open case observed (§7); `h = held_toman ≤ pending` | `disputed +h` / `pending −h` |
| `dispute_outcome` | the case closed with a decision | `disputed −h` / `refunded +r_d`, `pending +(h − r_d)` |
| `release` | §6 predicate true; commission snapshot not `absent`; deduction computed per §3 for the recognition kind | `pending −p` / `platform_earned +d_i` (per component), `available +(p − Σd)` |
| `reserve_hold` / `reserve_release` | settlement record (§8) | `reserve ±` / `available ∓` |
| `settlement` | privileged record (§8) | `settled +x` / `available −x` |
| `settlement_reversal` | reported failure; one per batch | `available +x` / `settled −x` |
| `recovery` | receivable outstanding (§9) | donor order: `recovery_out +y` / `reserve −y` or `available −y`; owed order: `platform_advance +y` or `platform_earned +y` / `recovered_in −y` |
| `fee` | verified provider report (§10) | `provider_fee +φ` / `platform_advance −φ` or `pending|available −φ` |

- **No journal kind has a guard of time alone** (R4).
- Settlement cadence is time-based, but it moves only money that is already `available`.
- `reserve` is kept as a separate account so that no settlement can consume it **[A7]**. R5 calls the reserve "a held fraction of `available` money"; a reader who wants R5's grouping sums `available + reserve`.
- `reversed` is the `settlement_reversal` journal kind, not an account.

### 6. Release predicate and the completion rule

**Obligation.** Release eligibility is decided in the **application** DataSource, where the booking, outcome and dispute facts live.
- `commerce.order_release_decisions (id, order_id, recognition_kind IN ('retention_outcome','completion'), recognition_instant, window_closed_at, observed_refunded_total_toman, decided_at)` has one live row per order.
- Its outbox event is `SellerFundsReleaseDecided v1`.
- A sweep and a lazy read converge on the same unique index.

**(a2) Retention outcome in the seller's favour.**
- The fact is a live ADR-051 cancellation or no-show decision with `retained_toman > 0`.
- It is final when its objection window closed with no case, or its case closed upholding retention, with the appeal window closed.
- The anchor is the decision's **database-clock** outcome instant.

**(a1) Plain completion [OC-1, decided by `V33-DEC-044`].**
- **Valid completion fact.** Either
  - the booking's `completed` row in `booking.booking_history`, when its `created_at` (database clock) is **at or after** `slot_start`; or
  - when that row predates `slot_start`, a later **completion attestation** by the performing professional, recorded on the database clock at or after `slot_start`.

  A completion recorded before `slot_start` is **not** a valid release fact. It forfeits nothing: the money stays `pending` until a later valid completion or outcome fact exists. The attestation fact and its guard are owned by `#42f`.
- **Window.** Release requires `clock_timestamp()` ≥ the valid completion fact's instant + the order's snapshotted `dispute_window_hours` (`commerce.order_outcome_terms`).
- **Customer dispute.** During that window the customer may file an eligible dispute against the completed booking (the `completed_booking` subject owned by `#42f`, extending ADR-051 §9). An open case holds exactly its `held_toman` (§7).

**Window closure and open cases [T].** The deciding transaction locks the booking row `FOR UPDATE`, **then** reads `clock_timestamp()`. It requires the instant to be at or after the window end, and no `dispute.cases` row for the booking outside `closed`. `now()` (the transaction start) is never used.

**Orders with no outcome-terms snapshot [A4].** ADR-051's `legacy_unenrolled` orders have no `dispute_window_hours`, so they cannot satisfy the window condition, and their money stays `pending`.
- This is **fail-closed and not forfeiture**; no old order is reinterpreted.
- A **separate legacy disposition** is a prerequisite of any real-money rollout (§17). It is not decided here.

**Answering OC-1 activates nothing by itself.** `#43c` stays `status:proposed` until its implementation prerequisites (#160, #161, #162, `#42f`, #162's clock rule) and its external accounting and provider facts are satisfied.
- **Linearization with dispute filing [T].** ADR-051 §9's filing takes the booking `FOR SHARE` and compares its window against the transaction-start `now()`. A filing transaction that started just before the window end could therefore insert a case after a release committed. Before `#43c` is Ready, #162's filing must compare against `clock_timestamp()` read **after** acquiring the booking lock. Whichever transaction locks first then wins, and the other sees the committed result. This amends a mechanism ADR-051 owns; the correction is recorded in #162's own pull request.
- **Financial consumer convergence [T].** The consumer writes `release` keyed `release:<decision_id>`. It **defers** (throws; the relay retries) while its projected `refunded` for the order is below the decision's `observed_refunded_total_toman`, so a refund that preceded the decision never lands in `available`.

**Rejected.** *Release on completion alone* — a unilateral, unguarded click would release customer prepayment before the service. *Release on the window alone* — R4. *A fixed safety margin after the window end* — no database bound on transaction age makes it deterministic. *A default window for unenrolled orders* — no ratified value exists.

### 7. Dispute hold input

A hold is observed by `#43c`'s evaluator through a composition-root port over `dispute.cases` — `state`, `held_toman`, window and appeal window. It covers cases against retention outcomes, no-show declarations and, through `#42f`, completed bookings. The evaluator emits `DisputeHoldChanged v1` (keys `hold:<case_id>`, `hold_outcome:<case_decision_id>`). The hold is exactly `held_toman`, never the order's whole pending amount (`V33-DEC-039` R10). A case opened after money was released cannot occur while §6's linearization holds. If a hold cannot be posted, the consumer records a reconciliation exception (§12) and never forces a negative balance.

### 8. Settlement schedule, reserve, proposal and record

**Obligation.**
- **Schedule resolution** reads the seller's active subscription `snapshot_plan_key`, the current risk-class assignment and the active schedule version. Any of those missing ⇒ unresolved ⇒ not proposable (R8). There is **no default risk class** **[A3]**.
- **Weekly [A2].** A seller is proposable when `clock_timestamp()` is at or after their last non-reversed batch instant plus `settlement_interval_days`, or when no batch exists. The owner-endorsed initial publication is 7, stored as data. Calendar anchoring to a weekday is not ratified and is not built.
- **Preview.** Non-mutating. At the database instant, per seller: available, receivable recovery (§9), reserve target `min(cap ?? ∞, floor(available × reserve_bp / 10000))` and its delta, payable, and the minimum payout.
- **Record.** Privileged (`bc_manage_platform`), reason **mandatory**. Under the seller lock it recomputes everything, writes `recovery`, `reserve_*` and `settlement` journals, `settlement_batches` + `settlement_items`, and a sibling `financial.settlement_batch_terms` row: policy key and version, plan, risk class, reserve parameters, minimum payout, reason. A seller below the minimum payout is omitted.
- **Production boundary.** Under `NODE_ENV=production` the record is **refused** until #47's rail exists (`EXTERNAL_VERIFICATION_LEDGER.payment.verified` is false). `V33-DEC-041` R1 rejected "collect into BeauClick's account and settle manually" as the production posture **[T]**.
- **Failure and retry.** A reported failure writes `settlement_reversal` (one per batch), returning the items to `available`. A retry is a new batch. Nothing is re-sent.
- **The existing immediate route** `POST /api/v1/admin/finance/settlements` stays **refused for good**, at the service level, so no caller bypasses it. "Immediately, in full" is the schedule the owner rejected (R8).
- **Audit.** Detached (`transactional: false`); the financial batch row is authoritative. `V33-DEC-040`'s "same-transaction audit" is not achievable across ADR-017's DataSource boundary **[T]**.
- **Maker-checker** stays deferred (`V33-DEC-028` Ruling 13).
- **Reserve at seller exit** stays held; release on exit is not ratified **[A8]**.

### 9. Receivable and recovery

**Obligation.**
- `financial.seller_receivables (id, seller party, cause, cause_source_type, cause_source_id, amount_toman > 0, created_at)`, with `UNIQUE (cause, cause_source_type, cause_source_id)` and closed causes `commission_excess`, `post_settlement_refund`, `post_settlement_reversal`, `seller_fee` **[A6]**.
- `financial.receivable_recoveries (receivable_id, source IN ('reserve','future_available','manual_claim'), amount_toman, journal_id)`, with an outstanding-balance chain `CHECK (≥ 0)`.
- **Recovery order:**
  1. reserve — oldest provenance first;
  2. future `available` — applied inside the settlement record **before** payable is computed;
  3. manual claim — an administrator records the claim, then records its collection (amount ≤ outstanding, reference, mandatory reason, detached audit).
- **No write-off exists** **[A9]**. Legacy negative outstanding amounts are **not** converted into receivables. They stay visible legacy facts, and any conversion needs a separate owner decision.
- A post-settlement refund is **never refused**: the refund posting comes first and draws `platform_advance`, and the receivable follows.
- Sellers see their receivables as a distinct fact, with a booking reference and no customer identifier.

### 10. Provider fees and allocation, and OC-3

**Obligation [T].**
- A fee enters only as an **adapter-verified** report (a value object only the payment adapter can construct): `payment.provider_fee_reports (provider_key, provider_reference, order_id, fee_kind, amount_toman > 0, reported_at)`, `UNIQUE (provider_key, provider_reference, fee_kind)`, with the event `ProviderFeeReported v1`. The sandbox reports nothing; tests use a test adapter.
- Allocation reads the order's `(cause, timely)` facts: `customer_timely ≡ (customer, true)`, `customer_late ≡ (customer, false)`, plus `no_show`, `seller`, `platform`, `provider`, `force_majeure`.
- Bearers:
  - `platform` → `provider_fee / platform_advance`.
  - `seller` → deducted from that order's held seller money. For `customer_late` and `no_show` it is bounded by `retained_toman`, with the remainder borne by the platform. For `seller`, any shortfall becomes a `seller_fee` receivable.
  - An **unpublished pair** → `provider_fee / platform_advance`, labelled `unallocated`, with no deduction from anyone (R8). A refund posting never includes a fee.

**Completed bookings [OC-3, decided by `V33-DEC-044`].**
- R2 allocates fees by the cancellation cause, so a completed booking has no ratified bearer.
- A provider fee on a completed booking is allocated **only** through an administrator-published mapping for the cause key `completed` (per `fee_kind`, bearer `platform` or `seller`).
- **No default exists.** While that mapping is absent the fee is `unallocated`, and **no deduction is taken from anyone**.
- No mapping is published by this record.

### 11. Revenue-recognition facts

**Obligation.**
- `platform_earned:{component}` postings at `release` are the recognition facts for commission, acquisition and processing recovery (R3).
- No account or read field is named `revenue`. Every read returns per-type figures, and no field sums seller and platform money.
- The label "recognised revenue" is not used in any platform reporting until the accountant's and tax adviser's evidence is recorded (R3 external boundary).
- Subscription term-start and purchased-credit consumption recognition, and the unconsumed purchased-credit liability, are **not built now**. Subscription price is pinned to zero (`ck_seller_subscriptions_zero_price`), and no paid credit grant can exist before #99. They are deferred to the blocked child `#43h`.

### 12. Stock/flow identities (the engineering expression of R6)

**Why the written identity cannot hold [T].** Worked examples use a 10% commission and zero reserve unless noted.

| Id | Defect | Counter-example |
|---|---|---|
| D1 | `retained_seller` overlaps `pending/available/settled/disputed`: under R4, retained money stays in those states | Collect 100, late cancellation refunds 60 and retains 40, release gives commission 10 and available 30. Right-hand side = 60 + 40 + 10 + 30 = **140 ≠ 100** |
| D2 | Platform-borne fees are paid from platform funds, not from the collected amount | Collect 100, timely refund 100, provider fees 5 borne by the platform. Right-hand side = 100 + 5 = **105 ≠ 100** |
| D3 | `− receivable_recovered` is false between shortfall and recovery, and the donor order has no term | Order A collects 100, settles 100, then a reversal refunds 100. Right-hand side = 100 + 100 − 0 = **200 ≠ 100**. After recovery from order B, B's right-hand side is 0 ≠ 100 |
| D4 | No term for platform funds advanced | as D2 and D3 |
| D5 | `commission` is ambiguous between computed and deducted; an excess on `service_total` is not held money | `service_total` 500 at 10% = 50, held 40. Right-hand side = 60 + 40 + 50 = **150 ≠ 100** |

The independent review **withdrew** two further points the audit made:
- "No reserve term" is not a defect if the reserve is read as part of `available` (R5's wording).
- "A CHECK cannot sum rows" is not a contradiction, because R6 already allows a trigger.

**Identities [T].**
- **M0 — balanced journals.** For every journal and every order it touches, the signed postings sum to 0. Recovery journals also balance `recovered_in` against `recovery_out`. Enforced by the deferred constraint trigger.
- **M1 — per-order custody identity**, at any committed instant, all terms ≥ 0, flows cumulative, stocks current:

  `collected + platform_advance + recovered_in = refunded + pending + disputed + available + reserve + settled + platform_earned + provider_fee + recovery_out`

  M1 is implied by M0, and it is also asserted by a reconciliation read.
- **M2 — per-seller aggregate.** M1 summed over a seller's orders; `recovered_in` and `recovery_out` cancel.
- **M3 — per receivable.** `created = recovered_reserve + recovered_future + claim_collected + outstanding`, with outstanding ≥ 0. Recovered amounts equal the `recovered_in` postings.
- **M4 — per order and account.** The running-balance chain, `balance_after ≥ 0` by CHECK.
- **M5 — cross-DataSource reconciliation read.** `collected` equals `commerce.orders.collected_total_toman`, and, once converged, `refunded` equals `refunded_total_toman`. A mismatch older than the convergence horizon becomes an exception item in `financial.reconciliation_exceptions`, never a correction. The provider-file reader is #47's.
- **M6 — platform result, read only.** `platform_earned − platform-borne fees − unallocated fees − unrecovered advances`, kept apart from custody so seller money never enters it.

**Verification of the D-scenarios under M1.**

| Scenario | Left | Right |
|---|---|---|
| D1 | 100 | refunded 60 + available 30 + earned 10 |
| D2 | 100 + advance 5 | refunded 100 + provider_fee 5 |
| D3, order A before recovery | 100 + advance 100 | refunded 100 + settled 100 |
| D3, order A after recovery | 100 + advance 0 + recovered_in 100 | refunded 100 + settled 100 |
| D3, order B | 100 | recovery_out 100 |
| D5 | 100 | refunded 60 + earned 40 (receivable 10 under M3) |

`platform_advance` records a cash position — money the platform put in. **It is not an allocation of any cost to BeauClick**, and it creates no revenue or loss label.

### 13. Cross-DataSource and event boundary

| Fact | Schema / DataSource | Atomic with |
|---|---|---|
| Policy families, risk classes | `commercial` / application | admin audit row |
| `order_commission_terms` | `commerce` / application | booking, order, schedule, outcome terms |
| `order_release_decisions` | `commerce` / application | `SellerFundsReleaseDecided v1` outbox row |
| Provider fee reports | `payment` / application | `ProviderFeeReported v1` outbox row |
| Journals, postings, receivables, recoveries, batch terms, exceptions | `financial` / financial | financial outbox row |

- **No cross-DataSource transaction.** Consumers are at-least-once and idempotent by `fund_journals.idempotency_key`.
- An administrator action that needs commercial data reads the immutable versions first, then snapshots them **by value** into the financial rows.
- New financial facts leave through the existing financial relay as `FundsJournalRecorded v1`, with every consumer classified as ADR-045 §7 did.
- ADR-017's separate DataSource stays.
- Both DataSources are schemas of **one cluster**, so point-in-time recovery is consistent. The restore rehearsal must prove M1 and M5 after restore.

### 14. Role isolation and authorization

| Action | Authority | Audit |
|---|---|---|
| Publish or retire any family version; assign a risk class | `bc_manage_commercial_plans` (privileged, live-revoked) | same-transaction admin audit, mandatory reason |
| Settlement preview, record, reversal; manual claim record and collect | `bc_manage_platform` (privileged, live-revoked) | detached admin audit, mandatory reason; the financial row is authoritative |
| Seller funds read | live owner or `finance_read` grantee via `workspaceRef` (ADR-049 §5) | none; `Cache-Control: private, no-store`; non-enumerating refusal |
| Journal writes | system consumers only | financial row |

No route accepts a party, beneficiary or amount. DTOs whitelist their fields.

### 15. ADR-027 dispositions

| Table | Disposition | Export |
|---|---|---|
| `commercial` commission, allocation and schedule families | `retained` | nothing to customers or sellers |
| `commercial.seller_risk_class_assignments` | `retained` | to the owning seller party: class, instants, reason. Free-text reasons get a privacy review at `#43d`'s preflight |
| `commerce.order_commission_terms`, `commerce.order_release_decisions` | `retained` | nothing to customers |
| `payment.provider_fee_reports` | `retained` | provider references never exported |
| `financial.fund_journals`, `fund_postings`, `seller_receivables`, `receivable_recoveries`, `settlement_batch_terms`, `reconciliation_exceptions` | `retained` | to the seller: its own states, receivables (booking reference only) and batches |

### 16. Legacy regime and compatibility

- The regime is fixed per order by where its collection fact lives.
- Every pre-existing `financial.ledger_entries`, `settlement_batches` and `settlement_items` row stays **byte-identical**, proved by comparing row-text hashes before and after migration.
- `LedgerService.recordPayment` and `FinancialConfig` are removed. Legacy refunds keep reversing in `ledger_entries` (§3).
- The nine existing finance routes keep their shapes:
  - `receivableNetToman` = legacy receivable + new-regime `available + reserve + settled`;
  - `settledToman` = legacy + new-regime settled;
  - `outstanding-orders` lists legacy orders only.
- One additive route, `GET /api/v1/me/finance/:workspaceRef/funds`, returns the distinct states. The pinned route count moves from 9 to 10, with the reason in the tests.
- The pinned "outstanding goes negative" test is kept for the legacy regime only. The new regime proves non-negativity.
- Test seeds that call `recordPayment` or `createSettlement` move to real-PostgreSQL fixtures.

### 17. Production-activation boundary

Nothing in this record activates a real toman. The following stay refused or unbuilt in production until the named facts exist:
- settlement record — #47;
- payout instructions — #47;
- real fee reports — #47 and the provider's fee schedule;
- rail failure ingestion — #47;
- "recognised revenue" labels — accountant and tax evidence;
- subscription and credit recognition — #99, #47 and a paid-subscription decision;
- **any real-money release of seller funds** — additionally a separate, recorded **legacy disposition** for orders without an outcome-terms snapshot (A4), and for bookings whose only completion predates `slot_start` without a later valid fact.

Until that disposition exists, such money stays `pending`. That is never described or treated as forfeiture, and no old order is reinterpreted. Publishing a policy value moves no money. Answering OC-1, OC-2 or OC-3 moves no money.

---

## Transaction and lock ordering

| Operation | Order | Linearization point |
|---|---|---|
| Publish a family version | family row `FOR UPDATE` → version → audit | exclusion constraint; lifecycle trigger |
| Checkout commission snapshot | the existing checkout order, after the schedule: active versions `FOR SHARE` → insert three rows | `(order_id, component)` primary key |
| Collection, refund, fee, hold journals | advisory `fjo(order)` → chain reads → insert | `idempotency_key`; `seq` |
| Release decision | booking `FOR UPDATE` → `clock_timestamp()` → outcome and case reads → decision insert + outbox | live-row unique index |
| Release journal | `fjo(order)` → convergence check → insert | `release:<decision_id>` |
| Settlement record | `fjs(seller)` → `fjo(orders ascending)` → recompute → recovery, reserve, settlement journals → batch | `idempotency_key`; balance chains |
| Manual claim | `fjs(seller)` → `fjo(order)` → insert | receivable chain |

## Failure semantics

- Any of the following ⇒ **no journal written**, and a closed reason recorded. This is never a refusal of a customer refund, and never a forfeiture:
  - missing policy, or a commission snapshot `absent`;
  - no valid completion or outcome fact, or no snapshotted window;
  - unresolved schedule;
  - an unpublished `completed` fee mapping;
  - a production record without a rail.
- A refund is never blocked: beyond held money it draws `platform_advance`.
- A consumer behind its preconditions throws and the relay retries. A permanent mismatch becomes an exception item.
- Any trigger refusal rolls back the whole transaction.

## Concurrency invariants

1. One journal per idempotency key.
2. No fork of any balance chain.
3. No negative balance on any account or receivable.
4. One live release decision per order.
5. The sum of settled amounts never exceeds available, under any interleaving.
6. A dispute filing and a release on the same booking cannot both succeed across the window boundary.
7. One reversal per batch.

## Migration ordering (per child)

1. `#43a`: `fund_journals` → `fund_postings` → chain and balance triggers → grants → ADR-027 claims.
2. `#43b`: `commercial.commission_policies/_versions` → `commerce.order_commission_terms`.
3. `#43c`: `commerce.order_release_decisions`.
4. `#43d`: schedule family → risk-class assignments.
5. `#43e`: `settlement_batch_terms`.
6. `#43f`: `seller_receivables` → `receivable_recoveries`.
7. `#43g`: `payment.provider_fee_reports` → allocation family → `reconciliation_exceptions`.
8. `#43h`: none until unblocked.

Every migration is additive, proved from an empty database and against an already-applied one, and rewrites no existing row.

## Requirement-to-test matrix (every probe must fail with its guard removed and carries a non-vacuity control)

| Requirement | Proof | Child |
|---|---|---|
| M0 / M4 | unbalanced journal refused at commit; overdraw by 1 refused; zero allowed; parallel `seq` race gives one `23505` | a |
| Idempotency | triple delivery writes one journal | a |
| No commission at collection; no constant | `platform_earned` = 0 after capture; repository scan with a planted-literal self-test | a |
| Legacy byte identity and cumulative reversal | row-hash equality; 101 → 50 + 51 leaves 0 / 0 | a |
| Immediate route refused | service-level refusal; reversal of an existing batch still works | a |
| Shape CHECKs, required base, strict publication instant | each malformed shape refused; a backdated or tolerance-stamped publication refused | b, d |
| Snapshot at commitment | three rows per order; none on rollback; publication racing checkout deterministic; a version published after checkout does not change the release | b, c |
| BigInt floor and held ceiling | property tests assert at least one exact-half case was generated | b |
| Release predicate | Retention-outcome matrix. Completion at or after `slot_start` releases only after the snapshotted window with no open case. A completion before `slot_start` releases nothing until a later attestation at or after `slot_start`. An absent snapshot or an unenrolled order stays pending. The retained-amount base, cap and no receivable (OC-2) | c (+ `#42f`) |
| Clock boundary | a filing started before the window end versus a release after it: exactly one wins | c (+ #162) |
| Convergence | a decision ahead of its refund projection defers | c |
| Schedule, reserve, minimum payout, interval, production refusal, reversal, retry | boundary values; 10 parallel records never exceed available | d, e |
| Recovery order; post-settlement refund never refused | reserve then future available then claim; refund posted before the receivable | f |
| Allocation matrix; customer refund invariance; unallocated deducts nothing (including completed bookings without a published mapping); forged report writes nothing | per `(cause, fee_kind)` | g |
| Written-formula oracle | the R6 formula disagrees with the database on D1, D2, D3 and D5, and agrees on the trivial full-payment case | a |
| ADR-027 | boot coverage assertion; export and erasure per table | all |

## Considered and rejected (family-level)

| Alternative | Rejected because |
|---|---|
| Keep R6's written identity | false on D1–D5 |
| Commission deducted at collection | R3 recognises it at the outcome; it would force a fail-closed refusal onto the capture path |
| As-of commission resolution | not deterministic (§2) |
| Row locks on `financial` | the INSERT-only role cannot take them |
| Release on completion alone | an unguarded click releases prepayment before the service (OC-1) |
| Default risk class or default window | "never inferred"; no ratified value |
| Estimated fees | R2 "no amount is invented" |
| Write-off of a receivable | not ratified; R5 rejects BeauClick absorbing the loss by policy |
| Converting legacy negative outstanding to receivables automatically | creates a new seller liability from sandbox history without an owner decision |
| Separate database for financial | ADR-017 |

## Mechanism-to-child map

| Section | `#43a` | `#43b` | `#43c` | `#43d` | `#43e` | `#43f` | `#43g` | `#43h` |
|---|---|---|---|---|---|---|---|---|
| §1 families | — | commission | — | schedule, risk class | reads | — | allocation | — |
| §2–§3 snapshot, arithmetic | legacy reversal | **owns** | consumes | — | — | excess input | — | — |
| §4–§5 journal, states | **owns** collection, refund | — | release, hold | — | reserve, settlement | recovery | fee | — |
| §6–§7 release, hold | — | — | **owns** | — | — | — | — | — |
| §8 settlement | route refusal | — | — | publication | **owns** | hook | — | — |
| §9 receivable | — | — | — | — | — | **owns** | seller fee | — |
| §10 fees | — | — | — | — | — | — | **owns** | — |
| §11 recognition | — | — | platform share | — | — | — | — | subscription, credit |
| §12 identities | M0, M1, M4, M5 read | — | extends | — | extends | M3 | exception sink | — |
| §15–§16 privacy, legacy | **owns** | own tables | own tables | own tables | own tables | own tables | own tables | — |

`#42f` (a completed booking's valid completion fact and dispute eligibility) sits outside this map. It owns the attestation fact and the `completed_booking` dispute subject that `#43c` consumes, and it amends ADR-051 §9 in its own pull request.

## Open gates

- **Implementation prerequisites of `#43c`:** #160, #161, #162, `#42f`, and #162's `clock_timestamp()`-after-lock filing rule.
- **Legacy disposition:** a separate recorded decision for unenrolled orders and for completions that never gain a valid fact, before any real-money rollout.
- **External:** #47 (rail, fee schedule, reconciliation feed, payout); #99 (paid credits); accountant and tax evidence (recognition labels); Legal review of dispute copy and case-file retention (`gate:legal` on #162 and `#42f`).
- **Unpublished values:** every commission rate, fee allocation, schedule, reserve, minimum payout and risk class.
- **Deferred named decision:** maker-checker (`V33-DEC-028` Ruling 13).
