# PROPOSAL — `V33-DEC-044` (not ratified): Story #43 decomposition into `#43a`–`#43h`, technical corrections to `V33-DEC-040`, and three open owner decisions

**Status:** PROPOSAL — 2026-09-15 — awaiting explicit product-owner approval. NOT RATIFIED. NOT CLOSED.
**Engineering record:** [ADR-052](../../v3/adr/ADR-052-pending-funds-journal-commission-policy-and-settlement-release.md) (PROPOSED).
**Backlog:** #43 (unchanged: `status:proposed`, `sp:21`, `gate:external`). No issue has been created or edited. The live dashboard is unchanged at **264 / 350**.
**Evidence:** the read-only readiness audit of #43 against `b71f10cbb524e687243f53b5b63812eee80ae9a8` (2026-09-15), and the independent critical review recorded in §3 of this document. The audit's primary verdict was **NEEDS SPLIT**. The audit is evidence, not a decision.

> **How this document becomes binding.** Only an explicit owner approval — in a later message or a binding register card — can ratify it. On approval, the card text moves into `V3.3_DECISION_REGISTER.md` as `V33-DEC-044` with a closure-table row. This file is then deleted, ADR-052's status becomes Accepted, and `scripts/docs-audit.mjs` expects 44 cards. **None of those steps has happened.** Until they do, #43 stays exactly as it is, and no child issue exists.

---

## 1. Question

`V33-DEC-040` (2026-09-12) put #43 at `sp:21`, which the operating model forbids from entering Ready. It required a read-only readiness audit to propose a decomposition into children of 13 points or fewer, ratified by a later card, before any child becomes Ready. It also required the next ADR to be committed alone before any schema or code.

This proposal asks the owner to decide four things:

- how #43 splits;
- which technical corrections the ratified text needs in order to be buildable;
- which interpretations of that text engineering should apply;
- three product questions that the ratified text does not answer.

## 2. Evidence (verified at `b71f10c`)

| Fact | Where |
|---|---|
| `sp:21` "must not enter a cycle" | `docs/product/BACKLOG_OPERATING_MODEL.md:66-67` |
| The in-code rate `DEFAULT_COMMISSION_RATE_BP = 1500` and the `FINANCIAL_COMMISSION_RATE_BP` override still exist | `v3/services/financial/src/financial.config.ts:24-35`; `v3/apps/api/.env.example:101` |
| Capture posts commission and receivable immediately; refunds reverse at the original rate with round-half-away-from-zero, which can leave a one-toman residue after split refunds | `v3/services/financial/src/ledger.service.ts:67-218`; `v3/libs/money/src/money.ts:82-139` |
| `financial.ledger_entries` cannot represent states, fee facts, receivables or non-percentage rules (`commission_rate_bp INT NOT NULL`, closed entry and reference types) | `v3/database/migrations/financial/20260820100004_create_financial_schema.sql:23-68` |
| One admin route settles any order immediately and in full. Its outstanding read runs outside the insert transaction with no lock and no cumulative bound (a race found by reading, not executed) | `v3/services/financial/src/settlement.service.ts:113-133, 200-276` |
| Outstanding may go negative (pinned); ADR-009 endorses it | `v3/apps/api/test/financial-integrity.pg-spec.ts:437`; ADR-009 decision 1 |
| Financial writes use a separate DataSource and INSERT-only role; their admin audit is detached | ADR-017; `v3/services/financial/src/financial.controller.ts:283-287` |
| `BookingService.complete()` has no time guard and uses the application clock; `booking_history.created_at` is the database clock | `v3/services/booking/src/booking/booking.service.ts:443-465`; `v3/database/migrations/booking/20260820100001_create_booking_schema.sql:111-123` |
| Only retention decisions and no-show declarations are disputable, and "this same window" is the second release condition | `V33-DEC-039` R9; `V3.3_OWNER_POLICY_RATIFICATION_2026-09-12.md:269` |
| ADR-051 dispute filing takes the booking `FOR SHARE` and evaluates its window against the transaction-start `now()` | ADR-051 §9 and its lock table |
| #160, #161 and #162 are `status:proposed` (#160 implementation is in progress on another branch); #47 and #99 are `status:blocked` | GitHub, 2026-09-15 |
| No `#43` branch, PR or implementation exists; the next unused ADR is 052 and the next card is `V33-DEC-044`; the next issue number is #171 | repository and GitHub, 2026-09-15 |
| Live dashboard: V3.3 264 / 350, proposed 68, ready 0, blocked 18, no warnings — confirmed by `scripts/backlog-report.mjs` read-only and by raw labels | issue #2 |

## 3. Independent critical review of the audit

The audit's recommendations were re-checked against the code and the ratified records before this proposal was drafted.

| Audit claim | Review result |
|---|---|
| The 86-SP, eight-child decomposition | **Confirmed**, with one risk: `#43a` is at the 13-point ceiling. It also has to migrate test seeds in five existing specs (`financial-integrity`, `finance-workspace-authorization`, `scoped-finance-read`, `finance-identification-cache-safety`, `financial-outbox-consumer`), which call `recordPayment`/`createSettlement`. If its preflight finds it does not fit, the additive funds read route moves to a separately estimated follow-up; it must not silently grow |
| R6's written identity is false | **Confirmed** for four defects (retention double count; platform-funded fees; recovery timing and the donor order; commission excess). **Withdrawn:** "no reserve term" — R5 calls the reserve "a held fraction of `available`", so this is a modelling choice, not an error. **Withdrawn:** "a CHECK cannot sum rows" as a contradiction — R6 already allows a trigger |
| M0–M6 replacement identities | **Confirmed** on every worked scenario (ADR-052 §12). `platform_advance` is recorded as a cash position only, **not** as an allocation of cost to BeauClick |
| Separate DataSource; detached audit | **Confirmed** (ADR-017; pinned by `operability-foundation.pg-spec.ts:139`). "Same-transaction audit" in `V33-DEC-040`'s privacy section cannot hold for financial writes — a technical repair |
| Refuse the immediate settlement route | **Confirmed** as ratified (`V33-DEC-040` R8). **Strengthened:** the refusal belongs at the **service** level, so tests and future callers cannot bypass it. After `#43e` the old route stays refused; only the schedule-gated path settles |
| Remove the legacy rate without altering existing rows | **Confirmed.** Existing rows stay byte-identical; legacy orders keep reversing in the old ledger. The cumulative reversal fixes the residue for future reversal rows only |
| A refund beyond pending in `#43a` is recorded against `platform_advance` with a marker | **Corrected:** under `#43a` alone, pending always equals collected minus refunded, so the case cannot arise. It is removed from `#43a` and appears first in `#43c`/`#43f` |
| `legacy_negative_outstanding` becomes a receivable automatically | **Reclassified as policy:** it creates a new seller liability from sandbox history. **Removed** from the proposal; any conversion would need a separate owner decision |
| `#43c` depends on #160–#162 and OC-1 | **Confirmed.** In addition, the commission base on a retention outcome is **not** a technical reading. R3 says BeauClick's share is "**on them**" (the retained amounts), while the audit charged it on the collected principal. It is now **OC-2** |
| Fee allocation adds a `completed` cause key with no default | **Reclassified as policy:** R2 allocates by cancellation cause only, and giving administrators a seller-bearer option for completed bookings is authority the owner has not ratified. It is now **OC-3** |
| Change #161 **and** #162 clocks | **Corrected:** #161's sweep and #162's filing already serialize through the declaration-state compare-and-swap, provided #162 aborts when that affects zero rows (ADR-051 §9 "state forward"). The remaining race is #162 filing versus `#43c` release on the booking row. **Only a #162 note is proposed** |

## 4. What approval would decide — classified

### 4.1 Decomposition (structure and scope)

| Alias | Issue | Outcome | SP | Status after approval | Gates | Depends on |
|---|---|---|---:|---|---|---|
| `#43a` | **#43** (keeps its number) | balanced append-only pending-funds journal for new collections and refunds; the in-code rate removed; the immediate settlement route refused; legacy rows byte-identical; one additive seller funds read | 13 | `status:ready` | none (`gate:external` removed) | ADR-052 accepted |
| `#43b` | new | commission, acquisition and processing-recovery policy families (four closed shapes, required base); commission terms snapshotted on each new order; BigInt engine | 13 | `status:proposed` | none | `#43a` |
| `#43c` | new | release predicate for retention outcomes; dispute hold; recognition of BeauClick's share at release; **plain-completion release disabled until OC-1 closes** | 13 | `status:proposed` (not Ready until OC-1 and OC-2 close) | `gate:external` (accountant/tax evidence for recognition labels) | `#43a`, `#43b`, #160, #161, #162, OC-1, OC-2, #162 clock rule |
| `#43d` | new | settlement schedule (plan × risk class), minimum payout, reserve and risk-class assignment publication | 8 | `status:proposed` | none | `#43a` |
| `#43e` | new | schedule-gated settlement preview and record, reserve hold, reversal to available, retry; production record refused until #47 | 13 | `status:proposed` | `gate:external` | `#43c`, `#43d` |
| `#43f` | new | seller receivable, recovered from reserve, then future available earnings, then a manual claim; post-settlement refund never refused | 13 | `status:proposed` | none | `#43e` |
| `#43g` | new | verified provider fee facts and allocation by cancellation cause; unallocated means no deduction; reconciliation exception sink | 8 | `status:proposed` (allocation for completed bookings waits on OC-3) | `gate:external` | `#43f`, #160, #161 |
| `#43h` | new | subscription and purchased-credit recognition facts and the unconsumed-credit liability | 5 | `status:blocked` | `gate:external` | #99, #47, a paid-subscription decision |

**Total 86 SP** against the unsplit 21, a **net V3.3 scope increase of +65**. Calibrations: #82 (13), #83 (13), #104 (8), #160 (13). Delivery order: `#43a` → {`#43b`, `#43d`} → `#43c` → `#43e` → `#43f` → `#43g`; `#43h` blocked. `#43a`, `#43b` and `#43d` can finish while #160 → #161 → #162 proceed.

### 4.2 Technical repairs (T) — no product or financial policy change

| Id | Repair |
|---|---|
| T1 | R6's written formula (kept verbatim as history) is superseded **as a formula** by ADR-052 §12's identities M0–M6. R6's intent — exact integer sums, database enforcement, reconciliation as a read, exceptions never auto-corrected — is unchanged |
| T2 | A new balanced journal (`financial.fund_journals`/`fund_postings`) instead of widening `financial.ledger_entries`; the legacy regime is fixed per order; existing rows stay byte-identical |
| T3 | BigInt floor arithmetic for the new regime; cumulative reversal for future legacy reversal rows |
| T4 | Cross-DataSource bridge by outbox with idempotency keys and the refund-convergence rule; no cross-DataSource transaction |
| T5 | Financial admin audit stays detached (ADR-017); the financial row is authoritative |
| T6 | Release window checks read `clock_timestamp()` after the booking lock. **#162's** filing adopts the same rule before `#43c` is Ready (ADR-051 is corrected in #162's own PR) |
| T7 | R2 causes encoded as `(cause, timely)`: `customer_timely ≡ (customer, true)`, `customer_late ≡ (customer, false)` |
| T8 | The immediate settlement route refused at the service level (R8). In production, a batch record is refused until #47's rail exists (`V33-DEC-041` R1) |
| T9 | Advisory locks per order and per seller, because the INSERT-only role cannot row-lock. The privilege rule is proved at `#43a` preflight |
| T10 | A refunded amount is never deductible; a commission on a **completion** that exceeds held money becomes a `commission_excess` receivable (R1's own mechanism) |

### 4.3 Interpretations of ratified text (A) — approved only together with this card

| Id | Interpretation | Reason | Consequence the owner should see |
|---|---|---|---|
| A1 | Commission terms are snapshotted at **order commitment** (checkout transaction) | `V33-DEC-028` Ruling 4; resolving later is not deterministic | A rate published between booking and completion never applies to that booking |
| A2 | "Weekly" is a rolling interval: proposable when `settlement_interval_days` have passed since the seller's last non-reversed batch; initial publication 7 | the owner endorsed only "weekly"; no weekday was ratified | No fixed payout weekday |
| A3 | No default risk class; an unassigned seller is not settleable | R4 "never inferred"; `V33-DEC-028` "no default" | An administrator must assign every seller a class before any payout |
| A4 | An order with no outcome-terms snapshot (ADR-051 `legacy_unenrolled`) never meets the window condition, so its money stays `pending` | R4(b) needs the snapshotted window; no value exists otherwise | Sellers not enrolled in an outcome policy (#159) receive no release for those orders; any other treatment is a new decision |
| A5 | An `absent` commission snapshot releases nothing (it is never a silent zero) | R1, R8 | An administrator must publish `zero` (or another rule) before any new order can ever release |
| A6 | Receivable causes are closed: `commission_excess`, `post_settlement_refund`, `post_settlement_reversal`, `seller_fee`; no automatic legacy conversion; no write-off | R1, R2, R5 | Unrecovered receivables stay open until a manual claim is collected |
| A7 | `reserve` is a separate account from `available`, so settlement cannot consume it | R5 "held" | Reads may sum both where R5's grouping is wanted |
| A8 | Reserve stays held when a seller leaves the platform | release at exit is not ratified | Needs a later decision if sellers exit |
| A9 | Seller-visible behaviour changes as ratified: new orders show `pending` (not receivable) until release; the existing admin "settle now" action refuses | R4, R8 | Sandbox sellers see no settleable balance until `#43c` and `#43e` exist |

### 4.4 Open owner decisions (OC) — not decided by this card

Each remains **OPEN** unless the owner explicitly answers it. The fail-closed behaviour applies until then.

**OC-1 — Release of a plain completed booking (gates `#43c` Ready).**

Evidence:
- R4 needs completion **and** a closed objection window.
- R9 makes only retention decisions and no-show declarations disputable.
- `complete()` has no time guard, so under completion-only release a seller could release a customer's prepayment before the appointment.

| Question | Options | Recommended | Reason |
|---|---|---|---|
| OC-1a — Does a window apply to a plain completion, and from when? | (i) none: available at completion · (ii) the snapshotted `dispute_window_hours`, measured from the **database-clock** completion instant (`booking_history.created_at` of the `completed` row) | **(ii)** | (i) turns a unilateral click into immediate release, the pattern the owner rejected for no-shows (Q10-A). (ii) matches Q20's wording and Q13's rationale |
| OC-1b — May a customer dispute a completed booking inside that window? | (i) no; the window is only a delay · (ii) yes, category `standard` or `bodily_harm`, holding at most the seller-attributable held amount | **(ii)**, via an additive change to #162 | A window nobody can use is not an objection window; `bodily_harm` has no other plausible subject |
| OC-1c — Does a completion recorded before `slot_start` release money? | (i) yes · (ii) no; the money stays `pending` and is flagged; booking status behaviour is unchanged | **(ii)** | Prevents self-release before the service without changing the booking domain |

**While open:** no ordinary-completion release path exists; `#43c` stays `status:proposed`.

**OC-2 — Commission on a retention outcome (gates `#43c` Ready).**

Evidence: R1's base vocabulary is `{platform_collected_amount, service_total}`; R3 gives BeauClick "its published commission share **on**" retained amounts. Example: collect 100, refund 60, retain 40, 10% commission.

| Option | Result in the example | Assessment |
|---|---|---|
| A — literal R1: base = collected principal or service total; the excess over held money becomes a receivable | 10 (or 50 on a 500 service total, leaving a 10 receivable) | Can make a seller owe money on a booking that never happened |
| **B — recommended:** on a retention outcome every percentage part uses the **retained amount** as its base, and the total deduction is capped at the retained amount **with no receivable**. Completions follow R1 literally | 4 | Matches R3's "on them"; no seller debt from a cancellation |
| C — no commission on retention outcomes | 0 | Contradicts R3's explicit share |

**While open:** a retention outcome whose snapshot has any non-`zero` component stays `pending`. With the owner-endorsed first publication (`zero` everywhere), A, B and C coincide and release proceeds.

**OC-3 — Who bears provider fees on a completed booking, or any cause outside R2's list (gates `#43g` allocation for those cases).**

Evidence: R2 maps only cancellation causes, and a collection fee on an ordinary completed booking has no ratified bearer.

| Option | Assessment |
|---|---|
| A — BeauClick always | simple; the platform bears the cost of the successful path |
| B — the seller always | deducted from the seller share (R5 order for any shortfall) |
| C — **recommended:** an administrator-published mapping for `completed` with **no default**, unallocated (no deduction) while unpublished | keeps V33-DEC-028's "values are published data" and fails closed |

**While open:** such fees are `unallocated`, no deduction is taken, and no `completed` mapping key exists.

## 5. Proposed rulings (on approval)

1. #43 cannot be Ready at 21 points; the reason is the operating model, not the owner.
2. #43 decomposes into the eight outcomes of §4.1 at the estimates shown (86 SP; net +65).
3. #43 keeps its number as `#43a`. No umbrella issue; no points on epic #38.
4. The delivery order and dependencies of §4.1 bind. Only `#43a` becomes Ready. `#43c` stays proposed until OC-1 and OC-2 are recorded and #162's clock rule is in place.
5. Technical repairs T1–T10 are adopted; ADR-052 is their engineering record.
6. Interpretations A1–A9 are adopted as listed.
7. OC-1, OC-2 and OC-3 stay **open** unless the owner's approval explicitly answers them. Answering them requires the owner's words, not this card's recommendations.
8. `gate:external` is removed from #43 (`#43a`) and placed on `#43c`, `#43e`, `#43g` and `#43h`, naming #47, #99 and the accountant/tax/provider evidence.
9. `V33-DEC-039`–`V33-DEC-043` are unchanged. `V33-DEC-040` R1–R8 stand verbatim, apart from the stated supersession of R6's formula text.
10. No commission rate, fee allocation, schedule, reserve, minimum payout or risk class is published. No provider, rail or payout is activated. No revenue figure is labelled recognised. No frontend story is created.

## 6. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Keep #43 at 21 | forbidden by the operating model |
| Merge `#43d`+`#43e` or `#43f`+`#43g` | each merge is 21 points |
| Split by code layer | a layer delivers nothing a test or user can accept |
| Keep R6's written identity | false (ADR-052 §12) |
| Widen `financial.ledger_entries` | cannot carry the facts (§2) |
| Commission deducted at collection | R3 recognises it at the outcome |
| As-of commission resolution | not deterministic |
| Release on completion alone | unguarded self-release (OC-1) |
| Treat OC-2 or OC-3 as technical | each changes who owes or pays money |
| Automatic conversion of legacy negative outstanding | creates seller debt without an owner decision |
| Change #161's clock | already serialized by the declaration compare-and-swap |
| Create `#43h` later, from #99's audit | hides known scope from the dashboard |
| Umbrella epic | precedent (#42, #83, #95, #110, #149) keeps the number on the first child |

## 7. Proposed issue mutations — **not applied**

| Issue | Mutation on approval |
|---|---|
| #43 | retitle to Appendix A's title; body = Appendix A; labels `−sp:21 +sp:13`, `−status:proposed +status:ready`, `−gate:external`; keep `type:story, priority:p1, track:engineering`, milestone V3.3 |
| new ×7 (from #171, re-verified at the time) | create `#43b`–`#43h` from Appendices B–H, with their labels and milestone V3.3 |
| #38 | child line "#43" → the eight aliases with their issue numbers (no points) |
| #162 | dated additive note: the `clock_timestamp()`-after-lock filing rule, and that case facts are read by `#43c` through a composition-root port; labels and estimate unchanged |
| #47 | dated note: the reconciliation exception sink is `#43g`'s table, and the provider-file reader stays #47's; labels unchanged |
| #99 | dated cross-reference: `#43h` depends on it; labels unchanged |
| #45, #149, #152, #160, #161 | unchanged |

**Projected dashboard after the mutations:** V3.3 scope 350 → **415**, done 264, proposed 68 → **115**, ready 0 → **13**, blocked 18 → **23**, no warnings (63.6%). Recompute with the live figures if the backlog has moved.

## 8. What approval would and would not activate

**Would:**
- ADR-052 Accepted;
- this card in the register;
- #43 becomes `#43a` (Ready) and seven issues are created;
- `#43a` may start from a fresh preflight on its own `feature/` branch.

**Would not:**
- any commission rate, fee allocation, schedule, reserve, minimum payout or risk class;
- any ordinary-completion release (OC-1), any non-zero commission on a retention outcome (OC-2), any fee allocation for completed bookings (OC-3);
- any real payout, provider, rail, credential, fee amount or production settlement (#47);
- any paid-credit or subscription recognition (#99);
- any revenue figure labelled recognised (accountant/tax evidence);
- any frontend work, tag, Release or deployment;
- implementation of any child in the approval turn.

---

## Appendix — proposed issue bodies

### Appendix A — `#43a` (issue #43)

**Title:** `[Story] Pending-funds journal foundation, removal of the in-code commission rate, and closure of the immediate settlement route (#43a)` · **Labels:** `type:story, status:ready, priority:p1, sp:13, track:engineering` · **Milestone:** V3.3

```markdown
**This is `#43a`**, the first child of #43's decomposition by `V33-DEC-044`; ADR-052 is its engineering record.

## Outcome
As a seller and a platform finance operator, every newly collected toman is recorded as `pending` in an append-only, balanced journal; no commission number exists in code; and no order can be settled immediately in full — so no seller is paid before an outcome, and the platform can prove where every collected toman is.

## Binding authorities
`V33-DEC-040` R1 (rate removal), R4 (pending at collection), R6 (as expressed by ADR-052 §12), R8; `V33-DEC-028` Rulings 2, 3, 9; `V33-DEC-024` Rulings 3–4; `V33-DEC-025` R7; `V33-DEC-041` R1; ADR-017; ADR-025; ADR-052 §4, §5, §8 (route), §12, §13, §15, §16. Nothing awaits the owner.

## Acceptance criteria
**Journal**
- [ ] `financial.fund_journals` and `financial.fund_postings` with ADR-052 §4's accounts; `idempotency_key UNIQUE`; per-(order, account, component) `seq`/`balance_after` chain with `CHECK (balance_after >= 0)` and a chain trigger; a DEFERRABLE constraint trigger refusing any journal not summing to zero per order; writer INSERT + SELECT only.
- [ ] Beneficiary copied from the order's seller party through the capture event; a trigger refuses a posting whose party differs from the order's first collection.
- [ ] Per-order advisory lock around every journal insert; the privilege rule that makes row locks unavailable is proved against the real server.

**Collection and refund (new regime)**
- [ ] `OrderPaid v1` / `OrderCollectionCaptured v1` write one `collection` journal (`pending +c / collected −c`); no commission and no receivable row; the venue balance is never posted.
- [ ] `OrderRefunded v1` writes one `refund` journal drawing `pending`; redelivery of either event writes nothing.

**Legacy regime**
- [ ] Orders whose collection is a `financial.ledger_entries` row keep that ledger for life; their refunds reverse there at the original rate with the cumulative rule (101 refunded as 50 + 51 leaves commission 0 and receivable 0); every pre-existing `ledger_entries`, `settlement_batches` and `settlement_items` row is byte-identical before and after migration (row-text hashes).

**Removal and closure**
- [ ] `FinancialConfig`, `DEFAULT_COMMISSION_RATE_BP`, `FINANCIAL_COMMISSION_RATE_BP` and `LedgerService.recordPayment` are removed (code, `.env.example`, test factory, specs); a repository scan with a planted-literal self-test proves no commission constant, env key, default or seed survives.
- [ ] `SettlementService.createSettlement` refuses every request with `SETTLEMENT_REJECTED` and closed reason `settlement_schedule_unpublished` (service level, so no caller bypasses it); reversal of an existing batch still works; the admin web page renders the refusal without a frontend change.
- [ ] Specs that seeded through `recordPayment`/`createSettlement` use real-PostgreSQL fixtures instead.

**Reads**
- [ ] The nine finance routes keep their shapes, with the ADR-052 §16 mapping; the pinned "outstanding goes negative" test is kept for the legacy regime only.
- [ ] One additive route `GET /api/v1/me/finance/:workspaceRef/funds` returns per-state totals as distinct fields (owner or `finance_read`, `private, no-store`, non-enumerating); the pinned route count moves 9 → 10 with the reason in the tests; no field sums seller and platform money.
- [ ] If the preflight shows the read route does not fit within 13 points, it moves to a separately estimated follow-up before implementation starts.

**Privacy and events**
- [ ] ADR-027 `retained` claims for every new table; seller export of its own states.
- [ ] `FundsJournalRecorded v1` on the financial relay; every consumer classified.

## Boundaries and non-goals
No commission policy (`#43b`), release (`#43c`), schedule or reserve (`#43d`), settlement (`#43e`), receivable (`#43f`), fee (`#43g`) or recognition label; no change to #160–#162 decisions; no frontend; no provider; no production activation; no value published; no tag, Release or deployment.

## Dependencies
ADR-052 accepted and merged. Independent of #160–#162; coordinate rebases of `v3/apps/api/src/events/financial-projection.handlers.ts` with #160.

## Required evidence
Real PostgreSQL: balance trigger, chain CHECK, idempotency under parallel duplicate delivery, legacy byte identity and cumulative reversal, the M1 reconciliation read under a property test, grants, service-level refusal, read-shape pins, the written-R6-formula oracle disagreeing on ADR-052's D-scenarios, restore rehearsal, container and full CI; mutation probes with non-vacuity controls per ADR-052's matrix.

## Story-point estimate
**13** — at the ceiling; calibrated against #82 (13).
```

### Appendix B — `#43b`

**Title:** `[Story] Versioned commission, acquisition and processing-recovery policy families with an order commission snapshot (#43b)` · **Labels:** `type:story, status:proposed, priority:p1, sp:13, track:engineering`

```markdown
**This is `#43b`** (`V33-DEC-044`; ADR-052 §1–§3).

## Outcome
As an administrator, I can publish, version and retire commission, acquisition and processing-recovery rules in exactly four closed shapes, and every new order records by value which rule — or its explicit absence — binds it. Commission is never a code number and is never re-read later.

## Acceptance criteria
- [ ] `commercial.commission_policies` / `_versions` with `component IN ('booking_commission','acquisition','processing_recovery')`, `rule_kind IN ('zero','percentage','fixed','hybrid')`, CHECKs pairing each shape to exactly its fields, `base` required for `percentage`/`hybrid` with no DEFAULT; ADR-048 lifecycle and window exclusion; `bc_manage_commercial_plans`; mandatory reason; same-transaction audit; nothing seeded.
- [ ] Publication instant exactly the transaction `now()`, and `activation_starts_at >= published_at` (no tolerance); backdating refused by trigger.
- [ ] `commerce.order_commission_terms` written in the checkout transaction for every new order and component (`absent | zero | rule`), resolved under `FOR SHARE` through a Commerce-owned port; append-only; none on rollback.
- [ ] Pure BigInt engine in `packages/commercial-policy-contract` (floor division, fixed component order, held ceiling, completion excess) with property tests up to `MAX_AMOUNT_TOMAN`.
- [ ] No journal posting is written; no checkout outcome changes (a missing policy never refuses checkout).

## Non-goals
No recognition or release (`#43c`), no receivable creation, no seller selection, no value published, no frontend.

## Dependencies
`#43a`; ADR-052 accepted.

## Evidence
Lifecycle, window and non-retroactivity; shape CHECK matrix; three snapshot rows per order and none on rollback; publication racing checkout is deterministic; no-seed exact-set test; mutation probes per ADR-052.

## Story-point estimate
**13**.
```

### Appendix C — `#43c`

**Title:** `[Story] Release predicate, dispute hold and completion-time commission recognition (#43c)` · **Labels:** `type:story, status:proposed, priority:p1, sp:13, gate:external, track:engineering`

```markdown
**This is `#43c`** (`V33-DEC-044`; ADR-052 §3, §5–§7, §11, §13).

## Outcome
As a seller, my pending money becomes `available` only after a recognised outcome and a closed objection window with no open dispute, and BeauClick's published share is recognised at that moment. A dispute holds exactly the disputed amount. Time alone never releases anything.

## Not Ready until
OC-1 (plain-completion release) and OC-2 (commission on a retention outcome) are recorded by the owner, and #162's filing evaluates its window with `clock_timestamp()` after the booking lock. While OC-1 is open, **no ordinary-completion release path exists**. While OC-2 is open, a retention outcome with any non-`zero` commission component stays `pending`.

## Acceptance criteria
- [ ] Release evaluator (pure function in `services/commercial-policy`) + `commerce.order_release_decisions` + `SellerFundsReleaseDecided v1`; sweep and lazy read converge on one live decision per order.
- [ ] (a2) Retention outcomes in the seller's favour from #160/#161/#162 facts, final after their window or case closure (appeal window included), anchored on a database-clock outcome instant.
- [ ] (a1) Plain completion: implemented exactly as the owner's OC-1 answer states; disabled if OC-1 is not answered.
- [ ] Window and open-case checks use `clock_timestamp()` read after the booking row `FOR UPDATE`; orders without an outcome-terms snapshot never release (A4); an `absent` commission snapshot never releases (A5).
- [ ] Financial consumer writes `release` (pending → `platform_earned` per component + available) from the order snapshot, keyed `release:<decision_id>`, deferring while projected refunds lag the decision's observed refunded total.
- [ ] Dispute hold of exactly `held_toman` and its outcome journal; a partial refund never exceeds held.
- [ ] The funds read and admin totals gain `disputed`, `available` and `platform_earned:{component}` as distinct fields; no "revenue" label.

## Non-goals
No settlement, receivable recovery or fees; no change to #160–#162 decisions; no recognised-revenue label in production reporting (accountant/tax evidence — `gate:external`).

## Dependencies
`#43a`, `#43b`, #160, #161, #162 merged; OC-1; OC-2; #162 clock rule.

## Evidence
Predicate matrix (completion without window, window without completion, open case, closed case, appeal window open, absent snapshot, unenrolled order, OC-2 non-zero); filing-versus-release interleaving at the window boundary; duplicate delivery; late refund convergence; M1 after every scenario; mutation probes per ADR-052.

## Story-point estimate
**13** — calibrated against #160 (13).
```

### Appendix D — `#43d`

**Title:** `[Story] Settlement schedule, minimum payout, reserve and seller risk-class policy publication (#43d)` · **Labels:** `type:story, status:proposed, priority:p1, sp:8, track:engineering`

```markdown
**This is `#43d`** (`V33-DEC-044`; ADR-052 §1, §8).

## Outcome
As an administrator, I can publish settlement schedules by plan and risk class (interval, minimum payout, reserve percentage and cap) and assign each seller a risk class with a reason, so settlement cadence and reserve are published data, never code.

## Acceptance criteria
- [ ] `commercial.settlement_schedule_policies` / `_versions` keyed by `(plan_key, risk_class)`: `settlement_interval_days > 0`, `minimum_payout_toman >= 0 NULL`, `reserve_bp 0..10000 NULL`, `reserve_cap_toman >= 0 NULL`; lifecycle, exclusion, strict database-clock publication, `bc_manage_commercial_plans`, reason, same-transaction audit; nothing seeded ("weekly" is data, initial 7).
- [ ] `commercial.seller_risk_class_assignments` (`standard | elevated`), one current row per party, forward-only, mandatory reason, same-transaction audit; no default, no inference.
- [ ] `SettlementTermsResolver` port returning `unresolved | resolved{terms by value}`.
- [ ] ADR-027 `retained`; risk class exported to the owning seller party; privacy review of free-text reasons at preflight.

## Non-goals
No proposal or batch, no reserve posting, no automated risk scoring, no frontend.

## Dependencies
`#43a`; ADR-052 accepted.

## Story-point estimate
**8** — calibrated against #104 (8).
```

### Appendix E — `#43e`

**Title:** `[Story] Schedule-gated settlement proposal, reserve hold, batch record, failure reversal and retry (#43e)` · **Labels:** `type:story, status:proposed, priority:p1, sp:13, gate:external, track:engineering`

```markdown
**This is `#43e`** (`V33-DEC-044`; ADR-052 §8).

## Outcome
As a platform finance operator, I can preview and record a settlement of exactly the `available` money a published schedule allows, with the reserve withheld, a mandatory reason and an append-only reversal that returns failed items to `available`. Nothing is settled without a schedule, and nothing is recorded as paid in production until a real rail exists.

## Acceptance criteria
- [ ] Non-mutating preview at the database instant per seller: available, recovery placeholder (0 until `#43f`), reserve delta, payable, minimum payout, snapshot terms.
- [ ] Record under the per-seller advisory lock: recompute; `reserve_hold`/`reserve_release` and `settlement` journals; `settlement_batches` + items + `financial.settlement_batch_terms` (policy key/version, plan, risk class, reserve, minimum, **reason NOT NULL**); `bc_manage_platform`; detached audit.
- [ ] Refused when the schedule is unresolved, the interval has not elapsed, the amount is below minimum, or under `NODE_ENV=production` without a configured real rail.
- [ ] Reversal writes `settlement_reversal` returning items to `available`; retry is a new batch; the old immediate route stays refused.
- [ ] Settlement events are nullable-correct.

## Non-goals
No payout adapter or bank instruction (#47); no maker-checker (`V33-DEC-028` Ruling 13); no receivable creation.

## Dependencies
`#43c`, `#43d`.

## Evidence
Ten parallel records never exceed available; minimum payout, reserve cap and interval boundaries; reversal and retry; production refusal; M1; mutation probes per ADR-052.

## Story-point estimate
**13**.
```

### Appendix F — `#43f`

**Title:** `[Story] Seller receivable and reserve → future earnings → manual claim recovery (#43f)` · **Labels:** `type:story, status:proposed, priority:p1, sp:13, track:engineering`

```markdown
**This is `#43f`** (`V33-DEC-044`; ADR-052 §9).

## Outcome
As the platform, money a seller owes — after settlement, from a completion's commission excess, or from a seller-borne cost — becomes an explicit receivable. It is recovered strictly from the seller's reserve, then from future available earnings before any later settlement, then by an administrator-recorded claim. No balance goes negative, and no customer refund is reduced or refused.

## Acceptance criteria
- [ ] `financial.seller_receivables` (causes `commission_excess | post_settlement_refund | post_settlement_reversal | seller_fee`; cause source NOT NULL, UNIQUE) and `financial.receivable_recoveries` (`reserve | future_available | manual_claim`); outstanding chain ≥ 0.
- [ ] A refund beyond held money posts first against `platform_advance`, and its receivable follows — never refused.
- [ ] Recovery runs inside `#43e`'s record before payable is computed, in the ratified order; recovery journals balance per order and across orders.
- [ ] Manual claim record and collection (`bc_manage_platform`, amount ≤ outstanding, reference, mandatory reason, detached audit); no write-off; legacy negative outstanding is not converted.
- [ ] The seller sees receivables as a distinct fact with a booking reference and no customer identifier.

## Non-goals
No write-off, no collection agency, no customer charge, no fee facts.

## Dependencies
`#43e`.

## Story-point estimate
**13**.
```

### Appendix G — `#43g`

**Title:** `[Story] Provider fee facts and administrator-published fee allocation by cause (#43g)` · **Labels:** `type:story, status:proposed, priority:p1, sp:8, gate:external, track:engineering`

```markdown
**This is `#43g`** (`V33-DEC-044`; ADR-052 §10).

## Outcome
As the platform, a gateway, refund or reversal fee enters only as a provider-reported fact. It is borne by BeauClick or the seller as the published allocation for the booking's cancellation cause says — never by the customer, never invented, and never deducted while no allocation is published.

## Acceptance criteria
- [ ] `payment.provider_fee_reports` constructible only through an adapter-side value object (test adapter in `v3/apps/api/test`; the sandbox reports nothing); `ProviderFeeReported v1`.
- [ ] `commercial.fee_allocation_policies` / `_versions` with rows `(cause_key, fee_kind) → bearer` over R2's cancellation causes, encoded `(cause, timely)`; an unpublished pair is unallocated.
- [ ] `fee` journals: platform or unallocated → `provider_fee / platform_advance`; seller → deducted from held seller money, bounded by `retained_toman` for `customer_late`/`no_show` with the remainder borne by the platform; a `seller` cause shortfall → `seller_fee` receivable.
- [ ] Fees on completed bookings stay unallocated until the owner answers OC-3.
- [ ] `financial.reconciliation_exceptions` sink (append-only) for #47's reader; never an automatic correction.

## Non-goals
No real provider, fee schedule or reconciliation reader (#47).

## Dependencies
`#43f`; #160; #161; OC-3 for completed bookings.

## Story-point estimate
**8**.
```

### Appendix H — `#43h`

**Title:** `[Story] Revenue-recognition facts for subscription terms and purchased booking credits (#43h)` · **Labels:** `type:story, status:blocked, priority:p1, sp:5, gate:external, track:engineering`

```markdown
**This is `#43h`** (`V33-DEC-044`; ADR-052 §11).

## Outcome
As the platform, subscription revenue is recorded at the start of each paid term, and purchased-credit revenue at each credit's consumption, with unconsumed purchased credit carried as a liability — by type, and never mixed with seller money.

## Why blocked
`ck_seller_subscriptions_zero_price` pins every subscription to 0 and no plan has a term; no `custom_purchase` grant can exist before #99, which waits on #47. Labelling any figure "recognised revenue" in production reporting also needs the accountant's and tax adviser's evidence (`V33-DEC-040` R3).

## Acceptance criteria (when unblocked)
- [ ] Recognition facts at paid-term activation and at each consumption of a `custom_purchase` grant, at the snapshotted unit price; returns reverse recognition; the liability read equals (purchased − consumed − refunded) × unit price.
- [ ] Per-type reads only; no mixed aggregate.

## Dependencies
#99, #47, a ratified paid-subscription path, accountant/tax evidence; `#43a`.

## Story-point estimate
**5**.
```
