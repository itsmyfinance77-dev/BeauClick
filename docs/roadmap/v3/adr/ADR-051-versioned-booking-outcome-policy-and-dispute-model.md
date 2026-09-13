# ADR-051 — Booking outcomes are evaluated once from an immutable, administrator-published, seller-selected and customer-accepted policy snapshot; no-show, the customer's choice and disputes are durable facts; and every Legal-dependent value is unwritable without recorded evidence

**Status:** Accepted — 2026-09-13
**Approver:** product owner (`V33-DEC-039` and `V33-DEC-042` ratified 2026-09-12; the decomposition this ADR serves is `V33-DEC-043`, ratified in the governance change that follows this commit)
**Backlog:** #42 (`#42a`, keeps its number) and the four children `#42b`, `#42c`, `#42d`, `#42e` created by the same governance change (see `V33-DEC-043` for the assigned numbers)
**Constrains:** `#42a`–`#42e`; leaves #43, #47 and #99 separate and unchanged
**Binding authorities:** [`V33-DEC-039`](../../v3.3/V3.3_DECISION_REGISTER.md) R1–R14 (the owner's cancellation, no-show, reschedule, dispute, retention and acceptance policy), [`V33-DEC-042`](../../v3.3/V3.3_DECISION_REGISTER.md) R1–R4 (intermediary role, snapshotted legal seller, responsibility split, never hard-coded), [`V33-DEC-028`](../../v3.3/V3.3_DECISION_REGISTER.md) Rulings 2, 4, 5 and 8 (every commercial parameter is an administrator-published immutable version; snapshot at commitment; non-retroactive publication; missing configuration fails closed), [`V33-DEC-029`](../../v3.3/V3.3_DECISION_REGISTER.md) Rulings 2–4 (`policy_accepted_at` means actual acceptance; no field filled with a placeholder), [`V33-DEC-031`](../../v3.3/V3.3_DECISION_REGISTER.md) (the seller-assignment and order-resolution shape), [`V33-DEC-010`](../../v3.3/V3.3_DECISION_REGISTER.md) (credit return on provider, business, administrator or platform cancellation), [`V33-DEC-030`](../../v3.3/V3.3_DECISION_REGISTER.md) (delegated calendar mutation explicitly deferred) and [`V33-DEC-043`](../../v3.3/V3.3_DECISION_REGISTER.md) (the five-child decomposition). None is reopened, re-decided or weakened here.
**Depends on:** [ADR-027](ADR-027-subject-data-contract.md) (subject-data coverage), [ADR-039](ADR-039-commercial-policy-control-plane.md) (Booking emits facts, Commercial Policy decides, Payment executes), [ADR-043](ADR-043-order-payment-schedule-snapshot.md) and [ADR-045](ADR-045-deposit-capture-collected-accounting.md) (the schedule snapshot, `collected_total_toman` and the refund ceiling), [ADR-046](ADR-046-booking-credit-accounting.md) (the cancellation entitlement seam and the `bcre` party lock), [ADR-048](ADR-048-booking-collection-policy-publication-and-assignment.md) (the versioned publication family, presence-as-enrollment, `FOR SHARE` plus compare-and-swap linearization and the Commerce-owned resolver port), [ADR-050](ADR-050-booking-credit-enforcement-control-plane.md) (the `bcgv` → order row → booking row → control row → `bcre` lock order this ADR must not violate), [ADR-011](ADR-011-repository-architecture.md) (module boundaries), [ADR-018](ADR-018-cross-domain-consistency.md) (same-cluster consistency)

**This ADR is the mandatory pre-code gate `V33-DEC-039` and `V33-DEC-043` require.** It is committed alone, as the first commit of its own governance pull request, containing exactly one new file. It writes no schema, no migration, no route, no DTO, no service, no controller, no contract, no event, no capability, no index, no seed and no test. It publishes no cutoff, retention, grace, window, cap, copy or retention period; it selects no provider; it is **not Legal, privacy, accounting or tax approval** and claims none. **No production code or schema for anything described below exists yet.** The owner-endorsed initial administrator publication values — 24 hours, 15 minutes, 72 hours — appear in this ADR only as the values an administrator is expected to publish first; nothing below turns any of them into a constant, default, fallback, seed or environment value.

---

## Context

### What the owner ratified

`V33-DEC-039` closed the product policy for cancellation, reschedule, no-show, dispute, retention and acceptance: the online amount is a prepayment; a timely cancellation is always free until a lawyer's written opinion says otherwise; the cutoff, the retention rule and the no-show grace are **seller selections inside administrator-published ranges**, snapshotted on the booking; late retention is `min(policyAmount, legalCap, collectedRemaining)` where `legalCap` is an administrator-published value **gated on recorded Legal evidence**; a no-show is a seller **declaration** at or after `slotStart + grace` that moves no money until an objection window closes; a seller, platform or provider cancellation gives the customer the choice of a full refund or a free reschedule; one reschedule is free before the cutoff; a dispute holds only the disputed amount, is decided by a privileged review team with one appeal by a different person, and its case file is privacy-bounded; the customer-facing policy is versioned, dated, immutable Persian text accepted **explicitly**; and every outcome is evaluated once from the snapshot on the database clock. `V33-DEC-042` fixed what that text says about BeauClick's role and the legal seller.

### What the repository does today (observed, not obligation)

The read-only readiness audit of 2026-09-13 against `57448ffd880a5977ec8d04c704764f1979126c75` traced every relevant path. The facts below are observed code; none is a rule this ADR keeps.

| Observed behaviour | Where |
|---|---|
| Statuses `pending \| confirmed \| completed \| cancelled \| expired \| no_show`; every change goes through `transition()` — legality map, compare-and-swap UPDATE, history row, **no outbox event of its own** | `v3/services/booking/src/booking/booking.service.ts:58-65, 772-823` |
| Actor vocabulary `customer \| professional \| system \| admin`; the seller actor is resolvable **only** as the professional's owning user — no business owner or manager path exists on cancel, complete or no-show | `v3/services/booking/src/entities/booking.entity.ts:37-38`; `v3/services/booking/src/booking/booking-party.resolver.ts:35-56` |
| `cancel()` records `cancelledByActorType/Id`, `cancelledAt: new Date()` (**application clock**), runs the mandatory entitlement seam, releases slot and resource, emits `BookingCancelled`, audits | `booking.service.ts:363-440` |
| Credit return maps `professional → seller_cancelled`, `system → platform_cancelled`; `admin` and `customer` return nothing | `v3/apps/api/src/composition/booking-credit-entitlement.adapter.ts:164-186` |
| `BookingCancelledRefundHandler` refunds **the whole remaining collected amount for every cause** — no time comparison, no cutoff, no retention; never-collected orders are cancelled with no provider call | `v3/apps/api/src/events/financial-projection.handlers.ts:231-284`; `remainingRefundable` at `v3/services/commerce/src/order/order.service.ts:749-751`; ceiling `ck_orders_refund_within_collected` |
| `PaymentService.refund` is idempotent on `UNIQUE (order_id, request_key)`, amount-parameterised, and ends `succeeded \| failed \| manual_required` | `v3/services/payment/src/payment.service.ts:755-838` |
| Reschedule refuses above `BOOKING_MAX_RESCHEDULES` (2) or below `BOOKING_RESCHEDULE_MIN_HOURS_BEFORE` (6), both environment-overridable code defaults evaluated on the application clock; same professional and service; price untouched | `v3/services/booking/src/booking.config.ts:45-51`; `booking.service.ts:502-517`; pinned by `v3/apps/api/test/booking-lifecycle.pg-spec.ts:219-229` |
| `markNoShow` refuses while `slotEnd > Date.now()` ("V2's rule, preserved verbatim"); no event, no audit line, no evidence, no money | `booking.service.ts:468-481`; route `booking.controller.ts:135-142` |
| Booking and order are created in **one transaction**; the schedule row holds `collection_mode`, the three amounts, `policy_key`, `policy_version`, **`policy_accepted_at` independently nullable and written by no merged story**, `contract_version` — and **no** cutoff, retention, grace, dispute or copy term | `v3/apps/api/src/checkout/checkout.service.ts:206-219`; `v3/database/migrations/commerce/20260905900001_create_order_payment_schedules.sql:34-73`; `20260907900001_replace_order_payment_schedule_policy_reference.sql:67-76` |
| A **pre-ratification** contract `BookingCommercialTermsV1` still exists (single cutoff in minutes, retention as basis points *of the deposit*, fixed 10 000-bp provider/platform refunds, `rescheduleDepositAction`, `disputeWindowMinutes`, `settlementDelayMinutes`, `customerPolicyCopyVersion`), consumed only by the in-memory `CommercialPolicyRegistry`, which is **not composed into the API** | `v3/packages/commercial-policy-contract/src/commercial-policy-contract.ts:40-53`; `v3/services/commercial-policy/src/commercial-policy.registry.ts:3-7` |
| **No dispute** table, state, window, hold, capability or route exists; privileged capabilities are `bc_manage_platform, bc_moderate_verification, bc_moderate_reviews, bc_moderate_media, bc_moderate_chat, bc_manage_commercial_plans`; `libs/audit` refuses to boot when a mutation gated on a privileged capability lacks an audit action | `v3/libs/auth/src/privileged-capability.port.ts:43-58`; `v3/libs/audit/src/audit-enforcement.ts:49,114` |
| The only explicit-acceptance precedent is per-user (`ai.assistant_consents (user_id PK, contract_key, accepted_at)`), not per order | `v3/database/migrations/ai/20260829400001_create_ai_schema.sql:257-264` |
| The publication family pattern (stable key, versions, `draft → published → retired`, exclusion-constrained windows, non-retroactivity CHECK, `bc_manage_commercial_plans`, same-transaction audit) and the seller-assignment pattern (opaque `workspaceRef`, one current row per party, forward-only supersession) exist and are the templates this ADR reuses | `v3/database/migrations/commercial/20260906950001_create_booking_collection_policies.sql:66-293`; `20260907800001_create_seller_collection_policy_assignments.sql:56-162`; `v3/services/commercial-policy/src/catalogue/commercial-catalogue.controller.ts:321-411`; `collection-policy-assignment/collection-policy-assignment.controller.ts:63-120` |
| `libs/media` has a `protected` access class with per-purpose `canView`; purposes are `portfolio \| avatar \| cover \| verification_evidence` | `v3/libs/media/src/media-policy.ts:20-53`; `media.service.ts:489` |
| `booking.bookings` and `booking.booking_history` are ADR-027 `subject_data`; the `commercial.*` policy tables are `retained`; a table nobody claims stops the API from booting | `v3/services/booking/src/booking/booking-subject-data.contract.ts:38-65`; `v3/services/commercial-policy/src/catalogue/commercial-subject-data.contract.ts:78-128` |
| Notification templates exist for `booking_cancelled` and `booking_rescheduled` only; platform display time is `Asia/Tehran` | `v3/apps/api/src/events/notification-analytics.handlers.ts:94-113`; `v3/services/booking/src/availability/platform-time.ts:17` |

### Why this ADR exists

The ratified policy needs mechanisms the repository lacks: a policy family with **ranges** a seller selects inside; an **outcome-terms snapshot** on the order; an **explicit acceptance** write; a **Legal-evidence** record that a `legalCap` cannot be published without; a **deterministic evaluator** with one durable decision per booking; a **no-show declaration** that replaces a V2 guard; a durable **customer choice**; a **dispute and appeal** case model; and ADR-027 dispositions for all of it. The audit also found that the one contract that looks like it already models this — `BookingCommercialTermsV1` — models the pre-ratification shape and must not become the source of truth. This ADR settles those mechanisms so that `#42a`–`#42e` can be written, reviewed and proved against a fixed design rather than against five different readings of `V33-DEC-039`.

---

## Decision

Sections 1–10 correspond to the ten mechanisms the readiness audit named. Every section separates **obligation** (what the children must build) from **rejected alternatives**. Names of tables, columns, routes and events below are **binding shapes**; a story may add a column the section does not forbid, but may not rename, drop or reinterpret one the section fixes.

### 1. Policy-family persistence — one versioned family per concern, ranges not values

**Obligation.** Two administrator-authored families are created under the `commercial` schema, each with the exact lifecycle of `commercial.booking_collection_policies` / `…_versions` (ADR-048 §3–§4): a stable key, immutable versions, `draft → published → retired` enforced by trigger, a `[activation_starts_at, activation_ends_at)` window with a GiST exclusion constraint per key, a database-authoritative non-retroactivity CHECK (`activation_starts_at >= published_at`), publication on `bc_manage_commercial_plans` with live revocation and a mandatory reason, and an admin audit row in the publishing transaction.

1. **`commercial.booking_outcome_policies` / `commercial.booking_outcome_policy_versions`** — the *numeric* family. A published version carries **ranges and sets a seller chooses inside**, never a single value the seller receives:
   - `cutoff_hours_allowed` — a non-empty, ascending `SMALLINT[]` of whole hours; the seller selects one member.
   - `late_retention_rules_allowed` — a non-empty set of retention rules, each of the closed shape `{ kind: 'none' | 'percentage_of_collected' | 'fixed_toman' | 'full_collected', bp?: 0..10000, amountToman?: >0 }`, stored as rows in `commercial.booking_outcome_retention_options (version_id, ordinal, kind, bp, amount_toman)` with CHECKs pairing `kind` to exactly the field it needs; the seller selects one.
   - `no_show_grace_minutes_allowed` — a non-empty ascending `SMALLINT[]`; the seller selects one.
   - `no_show_retention_rules_allowed` — the same shape as late retention, stored in the same option table with `purpose IN ('late_cancellation', 'no_show')`; the seller selects one.
   - `reschedule_free_count_before_cutoff` — a `SMALLINT >= 0` fixed by the administrator (the owner ratified **one**; the column exists so a later publication can change it without code, and the initial publication is expected to carry `1`).
   - `dispute_window_hours`, `bodily_harm_window_hours` (nullable, `>= dispute_window_hours` when present), `appeal_window_hours`, `case_file_retention_days` (nullable) — administrator values, not seller selections.
   - `legal_cap_rule` — nullable; the same retention-rule shape; **writable only under §5**.
   - `contract_version` — the version of the outcome-terms contract in §2.
2. **`commercial.customer_policy_copies` / `commercial.customer_policy_copy_versions`** — the *text* family. A version carries `locale = 'fa-IR'`, `body TEXT` (the Persian policy text, stored as data), `body_sha256`, `published_at`, and the same lifecycle. It carries **no** number: every number the customer sees is rendered from the numeric snapshot, so the text cannot drift from the terms.

**Separation the schema must make explicit.** Stable policy key (`policy_key`), immutable version (`version`), lifecycle (`lifecycle_state`), activation interval (`activation_starts_at`, `activation_ends_at`), administrator-selected values (the columns above) and **externally approved evidence** (`legal_evidence_id`, §5) are distinct columns; no column doubles as another. A published version is immutable (trigger `commercial.enforce_booking_outcome_policy_version_lifecycle`, mirrored from ADR-048); a correction is a new version.

**No hard-coded value.** No migration, seed, environment variable, code constant or test fixture may create a *production* version. The fail-closed reading of §3 and §6 is what the platform does when nothing is published, and the audit's test matrix (§11) proves it.

**Rejected.** *One family holding numbers and text* — a text correction would re-version every number and vice versa, and Legal review of text would block a numeric range change. *Seller-authored ranges* — contradicts `V33-DEC-039` R4 (administrator-bounded). *Reusing `booking_collection_policies`* — a collection policy decides how much is collected; an outcome policy decides what happens to it; coupling them would make a deposit change re-version cancellation terms. *A single value instead of a range* — contradicts R4/R6.

### 2. Supersession of `BookingCommercialTermsV1`

**Obligation.** `BookingCommercialTermsV1` and `BookingCommercialPolicySnapshotV1` (`v3/packages/commercial-policy-contract/src/commercial-policy-contract.ts:40-67`) are **superseded for this programme** and must not be reused, extended or re-versioned as `V2` for outcome terms. `#42b` introduces a new contract in the same package, `BookingOutcomeTermsV1` / `BookingOutcomeSnapshotV1`, with its own `BOOKING_OUTCOME_CONTRACT_VERSION = 1` and validator, alongside `BookingCollectionTermsV1` (which stays untouched).

The contradictions that make reuse unsafe, stated so no later reader treats them as an oversight:

| v1 field | Why it cannot carry the ratified policy |
|---|---|
| `cancellationCutoffMinutesBeforeStart: number` | one minute-based value; the ratified shape is a **seller selection in whole hours inside an administrator range** (R4) |
| `lateCancellationRetainBasisPointsOfDeposit`, `noShowRetainBasisPointsOfDeposit` | basis points **of the deposit**; the ratified shapes are `none \| percentage_of_collected \| fixed_toman \| full_collected` bounded by `legalCap` and by **collected** money (R5), and the no-show rule is a separate seller selection (R6) |
| `providerCancellationRefundBasisPointsOfDeposit: 10_000`, `platformFaultRefundBasisPointsOfDeposit: 10_000` | fixed literals; the ratified outcome is the **customer's choice** of full refund or free reschedule (R7), not a percentage |
| `settlementDelayMinutes` | settlement release is `V33-DEC-040` R4's predicate (completion event ∧ closed window), owned by #43; an outcome contract must not carry it |
| `rescheduleDepositAction` | a single enum; the ratified rule is a **count** of free reschedules before the cutoff, then evaluation under the cancellation policy (R8) |
| `customerPolicyCopyVersion: string` | couples text and numbers in one version; §1 separates them so each is versioned and reviewed independently |
| validator requires every field | the new contract must be **absent** (not zero-filled) when nothing is published, so that `#42c` fails closed rather than evaluating a placeholder (`V33-DEC-029` Ruling 3) |

**Preservation.** The v1 contract, the in-memory `CommercialPolicyRegistry` and their specs are **kept unchanged** by `#42a`–`#42d` because contract and sandbox tests reference them (`V33-DEC-029` Ruling 9 kept the registry behind a narrow port). `#42e`, the last child, may remove the v1 outcome fields and the registry **only** if its preflight proves no test or module still imports them; otherwise a later bounded cleanup story is created. No story may silently re-point the registry at the new contract.

**Rejected.** *Widen v1 in place* — every consumer would have to accept optional fields for values that must not exist, and the validator's "every field required" rule is the opposite of fail-closed. *Delete v1 in `#42a`* — deletes evidence and breaks sandbox tests for no gain.

### 3. Seller selection and the immutable snapshot

**Obligation (`#42b`).**

- A seller selects, per seller party, exactly one cutoff, one late-retention rule, one grace value and one no-show retention rule **from the members** of the numeric family version active at the database clock instant of the selection. Storage: `commercial.seller_outcome_policy_assignments` mirroring `seller_collection_policy_assignments` — `(party_type, party_id)`, `policy_key`, the four selected members copied by value (`cutoff_hours`, `late_retention_kind/bp/amount`, `grace_minutes`, `no_show_retention_kind/bp/amount`), `assigned_at`, `superseded_by_id` forward-only, `uq_sopa_one_current_per_party` partial unique on the current row, same-transaction audit. A selection whose members are not in the active version at selection time is refused; **the selection binds the key, not the version** (ADR-048 §4), so an administrator can re-range forward without migrating sellers, and a selection that a later version no longer allows makes resolution fail closed for new bookings until the seller re-selects.
- **Authority** is server-derived exactly as `V33-DEC-031`: the opaque `workspaceRef`, live ownership re-evaluated per request, `business_staff` affiliation granting nothing, one non-enumerating refusal. **Capability:** `#42b` reuses the existing non-privileged `bc_manage_own_collection_policy` — a seller who may choose how much is collected may choose what happens to it; a second capability would add a role-management surface for no security gain. (If its preflight finds an existing consumer that grants `bc_manage_own_collection_policy` to a party that must not select outcome terms, `#42b` creates `bc_manage_own_outcome_policy` instead and records why.)
- **Routes** (namespace audited for collision as `V33-DEC-031` did): `GET /api/v1/me/outcome-policies` (the assignable catalogue: `policyKey`, display name and the allowed members only), `GET/PUT /api/v1/me/outcome-policy-assignments/:workspaceRef`.
- **Resolution and snapshot** happen inside the **order transaction**, through a Commerce-owned port `BookingOutcomePolicyResolver.resolveForSellerParty(manager, sellerParty)` bound in the composition root (no Commercial Policy ORM import into `commerce`, ADR-048 §1). Outcome: `legacy_unenrolled` (no current assignment → the order carries **no** outcome snapshot and later stories treat it as always-timely, no-retention, `slot_end` no-show), or `resolved` with the version active at `now()` and the selected members, or `unavailable` (assignment exists but no active version / member no longer allowed / no active copy version) → the online-collection path is **refused** with the existing generic refusal and **no** snapshot is written.
- **Snapshot storage:** a new 1:1 table `commerce.order_outcome_terms (order_id PK REFERENCES commerce.orders, policy_key, policy_version, copy_key, copy_version, cutoff_hours, late_retention_kind/bp/amount, grace_minutes, no_show_retention_kind/bp/amount, reschedule_free_count, dispute_window_hours, bodily_harm_window_hours, appeal_window_hours, legal_cap_kind/bp/amount NULLABLE, legal_evidence_id NULLABLE, contract_version, resolved_at TIMESTAMPTZ DEFAULT now())`, append-only by trigger. A side table rather than columns on `order_payment_schedules` because the schedule is the collection contract (`V33-DEC-029`) and a `legacy_unenrolled` order legitimately has a schedule but no outcome terms; the absence of the row is the fail-closed fact.
- **Evaluation never re-reads live policy** (`V33-DEC-028` Ruling 4); **affiliation changes never move the snapshot** (the row keys the order, which keys the immutable seller party, `V33-DEC-025` R7).

**Rejected.** *Snapshot the version id only* — a later reader would re-read the family; the members must be copied by value. *Default a missing member from the range's first entry* — a hidden default, forbidden by `V33-DEC-028` Ruling 8 and `V33-DEC-027`'s rejection of "first row" rules. *Per-service selection* — deferred behind #44 exactly as `V33-DEC-029` deferred per-service collection policy.

### 4. Customer acceptance evidence

**Obligation (`#42b`).**

- Acceptance is a request field `acceptedPolicy: { copyKey, copyVersion, policyKey, policyVersion }` on the existing checkout command, **echoing what the server disclosed** in the preceding quote/disclosure read; the server compares it, inside the order transaction, with the version it resolves at `now()`. A mismatch (the customer accepted a version that is no longer active, or none) is refused with the generic refusal and **no** order, booking or snapshot is committed. There is no server-side fallback that fills the field.
- The durable fact is written in the same transaction as the booking, the order, the schedule and the outcome snapshot: `commerce.order_payment_schedules.policy_accepted_at = now()` (database time; the column and its independent nullability already exist), and `commerce.order_outcome_terms.copy_key / copy_version` record **which text** was accepted. `policy_key/policy_version` on the schedule keep their `#115` meaning (which collection policy priced the booking); `#42b` sets `policy_accepted_at` on that same row only when the outcome snapshot commits, so the row never says "accepted" about a booking with no terms.
- **No successful commitment without the required published copy:** an enrolled party with no active copy version resolves `unavailable` (§3) and the checkout refuses. A `legacy_unenrolled` party keeps today's path with `policy_accepted_at` NULL, exactly as today.
- **No unnecessary PII:** the acceptance fact is the instant and the versions; no IP address, user agent, device or free text is stored. The customer is already the order's customer.
- **Idempotency:** the checkout is already idempotent on the client `idempotencyKey` (`checkout.service.ts:201-219`); a replay returns the existing order and writes nothing, so two contradictory acceptance facts for one order cannot exist; `order_outcome_terms` is append-only and keyed by `order_id`.

**Rejected.** *A per-user consent table like `ai.assistant_consents`* — acceptance is per booking and per version; a user-level fact would let a later version be "accepted" retroactively. *Implied acceptance by proceeding* — contradicts R13. *Backend fills `policy_accepted_at` when the client omits the field* — the fabricated acceptance `V33-DEC-029` Ruling 3 forbids.

### 5. Legal-cap evidence mechanism — the load-bearing rule

**Obligation (`#42a`).** A `legal_cap_rule` may exist on a published outcome-policy version **only** if the version references a **valid** Legal-evidence record, and the database, not the application, enforces it.

- **Record:** `commercial.legal_evidence_records (id UUID PK, evidence_key VARCHAR(64) UNIQUE, subject VARCHAR(40) CHECK (subject IN ('retention_cap', 'withdrawal_posture', 'policy_copy', 'case_file_retention')), status VARCHAR(16) CHECK (status IN ('recorded', 'retired')), reference TEXT NOT NULL, reference_kind VARCHAR(24) CHECK (reference_kind IN ('document_reference', 'counsel_letter_reference', 'internal_ticket')), summary TEXT NOT NULL, recorded_by_user_id UUID NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), retired_by_user_id UUID, retired_at TIMESTAMPTZ, retire_reason TEXT, audit_id UUID NOT NULL)`. The record stores a **reference and a summary only** — never the document itself, never counsel's name, never the advice text. Whether the referenced document exists and says what the summary says is a fact a person attests to by recording it; the platform does not judge it.
- **Who may record:** a holder of `bc_manage_commercial_plans` (the existing privileged, live-revoked publication capability) through a new privileged sub-resource `POST /api/v1/admin/commercial/legal-evidence` and `POST …/legal-evidence/:key/retire`, each with a mandatory `reason` and a same-transaction admin audit row (`commercial.legal_evidence_recorded`, `commercial.legal_evidence_retired`). Maker-checker stays the deferred named future decision of `V33-DEC-028` Ruling 13.
- **Database enforcement:** `booking_outcome_policy_versions.legal_evidence_id UUID NULL REFERENCES commercial.legal_evidence_records (id)`; `CHECK (legal_cap_kind IS NULL OR legal_evidence_id IS NOT NULL)`; and a BEFORE INSERT/UPDATE trigger `commercial.require_valid_legal_evidence_for_cap` that refuses a **published** version whose `legal_cap_kind IS NOT NULL` unless the referenced record has `status = 'recorded'` and `subject = 'retention_cap'`. Retiring an evidence record does not rewrite published versions (immutability), but the evaluator (§6) re-checks the referenced record's status at decision time and treats a `retired` record as **absent** — so retention stops on the next decision without touching history.
- **Absence:** no record, a retired record, a record of another subject, or a version with `legal_cap_kind IS NULL` ⇒ `legalCap` is **absent** ⇒ `min(policyAmount, legalCap, collectedRemaining)` collapses to **zero retention** (§6). Nothing is ever "capped at zero by default"; the decision row records `legal_cap_state = 'absent'` so the reason is auditable.
- **Privacy:** ADR-027 `retained` with the stated reason "records a platform-level compliance attestation carrying the recording administrator's id; erasure of that administrator does not erase the attestation". Export returns nothing to any customer or seller (the record is about the platform, not a person). No customer- or seller-facing response ever includes the record.
- **Lifecycle:** `recorded → retired` only; no edit. A superseding opinion is a new record referenced by a new policy version.

**What this section does not do:** it does not name a cap, an amount, a document, a retention period, a lawyer or an approval wording, and it does not decide that any evidence exists.

**Rejected.** *A code-level ledger like `EXTERNAL_VERIFICATION_LEDGER` edited in a PR* — right for deployment facts (ADR-028) but wrong here, because a `legalCap` is an administrator publication that must be refusable **at publication time by the database**, and a code edit cannot be referenced by a row. *A boolean `legal_approved` column on the version* — unattributable, unretirable, and it stores an assertion with no reference. *Storing the opinion text* — privileged legal content in a product database with no need for it.

### 6. The deterministic evaluator

**Obligation (`#42c`; consumed by `#42d`/`#42e`).** One pure function in `services/commercial-policy`, `evaluateBookingOutcome(input): BookingOutcomeDecision`, plus one durable decision table in `commerce`.

- **Inputs, all facts:** the order's `order_outcome_terms` row (or its absence), `collected_total_toman`, `refunded_total_toman`, the booking's `slot_start`, the cause (`customer | seller | platform | provider | force_majeure | no_show`), the deciding instant `now()` read **in SQL inside the deciding transaction**, and the Legal-evidence state resolved in the same statement (§5). Never the application clock, never live policy.
- **Timely rule:** `timely ⇔ decidedAt <= slotStart − cutoffHours * interval '1 hour'`; the boundary instant is timely (`V33-DEC-039` R4). The comparison is done in SQL (`TIMESTAMPTZ` arithmetic) so no JavaScript `Date` participates.
- **Arithmetic:** integer toman as `BigInt`; `percentage_of_collected` = `floor(collectedRemaining * bp / 10000)`; `fixed_toman` = the amount; `full_collected` = `collectedRemaining`; `none` = 0; `legalCap` applied the same way to `collectedRemaining` when present; `retained = min(policyAmount, legalCap ?? 0 … no: legalCap absent ⇒ retained = 0)`, i.e. **absent cap short-circuits to zero**, then `refund = collectedRemaining − retained`.
- **Cause table:** `customer` timely → refund all; `customer` late → retained per the late rule; `no_show` (after the window, §7) → retained per the no-show rule; `seller | platform | provider | force_majeure` → refund all (retention 0) and the choice of §8; a `legacy_unenrolled` order (no terms row) → refund all for every cause, which is exactly today's handler.
- **Durability:** `commerce.booking_outcome_decisions (id, booking_id, order_id, decision_kind CHECK IN ('cancellation', 'no_show', 'reschedule_consequence', 'dispute_outcome'), cause, decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), policy_key, policy_version, cutoff_instant, timely BOOLEAN, collected_remaining_toman, policy_amount_toman, legal_cap_toman NULL, legal_cap_state CHECK IN ('applied', 'absent', 'retired'), retained_toman, refund_toman, execution_status CHECK IN ('pending', 'executed', 'manual_required', 'failed'), refund_request_key, superseded_by_id NULL)`, append-only by trigger, with **`UNIQUE (booking_id, decision_kind) WHERE superseded_by_id IS NULL`** — one live decision per booking and kind; a dispute outcome that changes the money writes a *new* `dispute_outcome` row and points the earlier row's `superseded_by_id` at it (never an UPDATE of amounts).
- **Concurrency:** the deciding transaction takes the booking row `FOR UPDATE`, then the order row `FOR UPDATE`, then reads terms and evidence, then inserts the decision; the partial unique index is the linearization point — a concurrent duplicate hits `23505` and returns the existing decision. This order is **inside** the ADR-050 order (`bcgv` → order row → booking row → control row → `bcre`): the cancellation path already holds the booking row when the entitlement seam runs (`booking.service.ts:363-405`); `#42c` therefore evaluates **after** the seam, on the `BookingCancelled` consumer side (replacing the unconditional branch of `BookingCancelledRefundHandler`), taking order `FOR UPDATE` → decision insert, and never re-acquires the booking row inside the seam's transaction. No new advisory-lock namespace is introduced.
- **Execution:** the decision row commits first; execution then calls `PaymentService.refund({ amountToman: refund_toman, requestKey: 'booking-cancelled:<bookingId>' })` — the **same** request key today's handler uses, so a booking cancelled before `#42c` and replayed after it cannot be refunded twice; `execution_status` records `succeeded → executed`, `manual_required`, `failed`. A non-succeeded execution never re-evaluates; a retry re-calls `refund` with the same key.
- **Fail-closed refusal:** a required configuration that is missing at *selection* time is the generic `policy_unavailable` refusal on the seller/checkout surface; at *decision* time nothing is refused — the absence of terms, cap or evidence simply yields the full refund, because a cancellation must never be blocked by policy. The decision row records why (`legal_cap_state`, `policy_key NULL`).

**Reschedule consequence (R8):** `#42c` retires `maxReschedulesPerBooking` and `rescheduleMinHoursBefore` **for bookings with a terms row**: the free count is the snapshot's `reschedule_free_count`, and a reschedule beyond it or after the cutoff is evaluated as `decision_kind = 'reschedule_consequence'` with cause `customer`, returned to the caller **before** the slot move commits (a preview read, then the move in the same transaction if the caller confirms with `acceptConsequence: true`). Bookings without a terms row keep today's guard and its tests. `BookingConfig`'s two getters stay until the last consumer is gone, then are removed by `#42c` with their env keys.

**Rejected.** *Evaluate on the application clock* — contradicts R14 and F3. *Cap absent ⇒ cap = policy amount* — silently activates retention with no Legal evidence. *Decide in the booking service* — inverts ADR-039 (Booking emits facts; Commercial Policy decides). *A new advisory-lock namespace* — unnecessary; row locks in the fixed order suffice and avoid a fourth namespace to reason about.

### 7. No-show declaration

**Obligation (`#42d`).**

- `booking.no_show_declarations (id, booking_id UNIQUE, declared_by_user_id, declared_at TIMESTAMPTZ NOT NULL DEFAULT now(), grace_minutes_snapshot SMALLINT, statement TEXT CHECK (length(btrim(statement)) BETWEEN 1 AND 2000), objection_window_ends_at TIMESTAMPTZ NOT NULL, evaluation_state CHECK IN ('window_open', 'disputed', 'evaluated'))`, append-only except `evaluation_state`, which moves forward only.
- **Guard:** for a booking whose order has a terms row, `markNoShow` requires `now() >= slot_start + grace_minutes * interval '1 minute'` **in SQL**, from `confirmed` only; for a booking with no terms row the existing `slotEnd > Date.now()` guard stays verbatim (fail-closed continuity; `booking-lifecycle.pg-spec.ts:156` remains valid for it).
- **Authority:** the declaring actor is the **professional session** resolved by `BookingProfessionalResolver` (`booking-party.resolver.ts:51-56`), exactly today's boundary. This ADR introduces **no** business owner, manager or `practitioner_chat` authority over a practitioner's bookings; that is the delegated-calendar decision `V33-DEC-030` explicitly deferred, and `V33-DEC-043` restates the boundary.
- **Evidence:** actor, instant, statement. **No** photo, file, geolocation, health or medical field exists on the table, and the DTO rejects unknown fields.
- **Money:** the declaration writes **no** refund, retention, ledger row or decision; the transition to `no_show` still occurs (status semantics unchanged) and the slot is not released (already past). `objection_window_ends_at = declared_at + dispute_window_hours` from the snapshot (the `bodily_harm` window is applied at filing, §9).
- **Consequences:** a booking-domain outbox event `BookingNoShowDeclared v1 { bookingId, professionalId, customerId, declaredAt, objectionWindowEndsAt }` (a **booking** event; `V33-DEC-023` R6's "no new commerce event" is untouched), an audit line `booking.no_show_declared`, and a notification template `booking_no_show_declared` to the customer through the existing notification module.
- **Window expiry → evaluation:** a **lazy-plus-sweep** mechanism: the evaluator (§6) may be invoked by a periodic sweep (`expireNoShowWindows`, modelled on `expireStaleHolds`, one transaction per booking) **or** by any read of the decision, and both paths converge on the same `UNIQUE (booking_id, decision_kind)` insert, so exactly one `no_show` decision exists regardless of which path ran first. A dispute filed before the window ends moves `evaluation_state` to `disputed` and the sweep skips it; evaluation then happens as the `dispute_outcome` of §9.
- **Never two penalties:** `late_cancellation` and `no_show` decisions are mutually exclusive by the booking state machine (a cancelled booking cannot be declared, a declared booking cannot be cancelled) and by the decision table's uniqueness.

**Credit-return closure (F5):** `CAUSE_BY_ACTOR` gains `admin → 'platform_cancelled'`; `customer` stays absent by design (customer-cancellation return remains a versioned policy value not decided by the 25 questions, ADR-046 §8 note of 2026-09-12).

**Rejected.** *Auto-no-show at `slot_end`* — the owner ratified a declaration with evidence and an objection window. *A `no_show` transition without a declaration row* — leaves the evidence and window nowhere. *Sweep only* — a customer reading the outcome a second after the window would see nothing; *lazy only* — money must move without a read.

### 8. Non-customer cancellation choice

**Obligation (`#42d`).**

- When `cancel()` runs with actor `professional`, `system` or `admin` (cause `seller | platform`; `provider` is recorded by the payment path when a verified collection is reversed after confirmation), the cancellation itself commits exactly as today — slot released, credit returned through the seam per `V33-DEC-010` (with `admin` now mapped, §7), `BookingCancelled` emitted. The evaluator's decision (§6, cause `seller|platform|provider`, retention 0) is written with `execution_status = 'pending'` and a new row `commerce.customer_remedy_choices (order_id PK, offered_at, options CHECK = '{refund,reschedule}', chosen VARCHAR(16) NULL CHECK IN ('refund','reschedule'), chosen_at NULL, resolved_by CHECK IN ('customer','default'), resolved_at NULL)` is inserted.
- The customer chooses through `POST /api/v1/bookings/:id/remedy` `{ choice: 'refund' | 'reschedule', newSlotId? }` under `BookingPartyResolver` restricted to the **customer** role. `reschedule` performs `BookingService.reschedule` **bypassing the cutoff and free-count rules** (cause is not the customer's) and transfers the terms row unchanged; the old slot is already released. `refund` (or any invalid or repeated request) executes the full refund immediately through the §6 path with the standard request key.
- **Default:** a choice is resolved to `refund` by `resolved_by = 'default'` when the platform executes the default. The trigger for the default is **the mechanism an administrator publishes as `remedy_choice_window_hours` on the numeric family** (a nullable column; when NULL, the default executes **immediately at cancellation**, i.e. today's behaviour, and the reschedule option is offered only while the refund is still `pending`/`manual_required`). This ADR **does not choose a deadline**; the owner ratified no number for it, and the immediate-default reading is the fail-closed one.
- **No double refund / double return:** the refund uses the single request key; the credit return is the seam's one idempotent row; `customer_remedy_choices.order_id` is the primary key, so a second choice is a `23505` that returns the existing resolution.

**Rejected.** *Invent a response deadline* — no ratified value exists. *Hold the refund indefinitely awaiting a choice* — contradicts R7's "default is the full refund". *Offer an internal credit* — rejected by the owner (Q11-D).

### 9. Dispute and appeal case model

**Obligation (`#42e`).** A new module `services/dispute` (own schema `dispute`, own ADR-027 contract), because a dispute is neither a booking fact nor a commerce fact and both must be readable by it through ports.

- **Tables:** `dispute.cases (id, booking_id UNIQUE, order_id, customer_id, seller_party_type, seller_party_id, subject CHECK IN ('late_retention_decision', 'no_show_declaration'), subject_decision_id NULL, subject_declaration_id NULL, category CHECK IN ('standard', 'bodily_harm'), filed_at DEFAULT now(), window_ends_at, held_toman BIGINT CHECK (held_toman >= 0), state CHECK IN ('open', 'more_information_requested', 'decided', 'appealed', 'appeal_decided', 'closed'), closed_at NULL)`; `dispute.case_statements (id, case_id, party CHECK IN ('customer', 'seller'), body TEXT, created_at)` append-only; `dispute.case_decisions (id, case_id, stage CHECK IN ('first', 'appeal'), decided_by_user_id, decided_at, outcome CHECK IN ('refund_customer_in_full', 'refund_customer_partially', 'uphold_retention', 'request_more_information'), partial_refund_toman NULL CHECK (partial_refund_toman IS NULL OR partial_refund_toman >= 0), reason TEXT NOT NULL, audit_id UUID NOT NULL)` append-only; `dispute.case_evidence_requests (id, case_id, requested_by_user_id, requested_at, reason TEXT NOT NULL, media_object_id NULL, submitted_at NULL, deleted_at NULL)`.
- **Eligibility:** `subject` must reference a live `booking_outcome_decisions` row of kind `cancellation` with `timely = false` and `retained_toman > 0`, or a `no_show_declarations` row with `evaluation_state = 'window_open'`; filed_at must be `< window_ends_at` where `window_ends_at = outcome_instant + (category = 'bodily_harm' ? bodily_harm_window_hours : dispute_window_hours)` from the order's terms row; `bodily_harm` is **only** a category value — the table has no symptom, injury, treatment or health column, and `case_statements.body` is free text the parties author, never a structured medical field. Anything else receives the **one** generic refusal already used across `v1/me/*`.
- **Hold:** `held_toman = retained_toman` (or the would-be retained amount for a no-show still in its window); while `state NOT IN ('closed')`, the §6 executor **must not** refund or retain the held amount and #43's future release predicate must not release it. Until #43 exists this is expressed as: the `no_show` evaluation is skipped (`evaluation_state = 'disputed'`) and the cancellation decision's execution stays `pending`. `held_toman` is written once and never changed; a partial refund is a **new decision row** (§6 supersession), so the amount is never duplicated.
- **Authority:** new privileged capability `bc_review_disputes` added to `PRIVILEGED_CAPABILITIES` (live revocation, `libs/audit` boot assertion), reviewer routes under `/api/v1/admin/disputes`. Every decision carries a mandatory `reason` and a same-transaction admin audit row (`dispute.case_decided`, `dispute.case_appeal_decided`, `dispute.case_information_requested`).
- **One appeal, different reviewer, database-enforced:** `UNIQUE (case_id, stage)` on `case_decisions`, and a BEFORE INSERT trigger `dispute.enforce_appeal_by_different_reviewer` that raises when `stage = 'appeal'` and `decided_by_user_id` equals the `stage = 'first'` row's `decided_by_user_id` for that case. An appeal is filed by either party within `appeal_window_hours` from the snapshot; the appeal decision is final in the platform.
- **Reviewer identity hidden:** every customer- and seller-facing projection omits `decided_by_user_id`, `requested_by_user_id` and `audit_id`; the parties see stage, outcome, amount and reason.
- **Non-enumeration:** filing, reading, appealing and submitting evidence collapse to the one generic refusal for any non-eligible booking, foreign booking, closed case or missing case; timing is bounded by constant-shape lookups as `V33-DEC-033` R3 required.
- **Immutable history:** no UPDATE on `case_decisions`, `case_statements` or `held_toman`; `cases.state` moves forward only (trigger).
- **Concurrency:** filing takes the booking row `FOR SHARE` and inserts the case; `booking_id UNIQUE` linearizes duplicates (`23505` → existing case). Deciding takes the case row `FOR UPDATE` then inserts the decision.

**Rejected.** *Put disputes in `commerce`* — commerce owns price and collection, not adjudication; *in `booking`* — a dispute needs the order's money facts. *Application-level "different reviewer" check* — a race between two reviewers defeats it; the trigger cannot be raced. *A medical sub-form for `bodily_harm`* — creates health data the owner and `V33-DEC-030` D1 excluded.

### 10. Privacy, retention and protected evidence

**Obligation.** ADR-027 dispositions, claimed by the owning module's subject-data contract in the same story that creates the table:

| Table | Disposition | Reason / treatment |
|---|---|---|
| `commercial.booking_outcome_policies`, `…_versions`, `…_retention_options`, `commercial.customer_policy_copies`, `…_versions` | `retained` | administrator publications carrying `created_by_user_id`/`published_by_user_id`; platform records, not a subject's data; export returns nothing to customers or sellers |
| `commercial.legal_evidence_records` | `retained` | compliance attestation carrying the recording administrator's id (§5) |
| `commercial.seller_outcome_policy_assignments` | `retained` | seller-party commercial history keyed by party, mirrors `seller_collection_policy_assignments`; exported to the owning seller as their own selections |
| `commerce.order_outcome_terms` | `subject_data` (customer) via the order | the accepted terms of the customer's own booking; exported with the order; erasure follows the order's existing treatment (`commerce.orders` disposition unchanged) |
| `commerce.booking_outcome_decisions`, `commerce.customer_remedy_choices` | `retained` | financial decisions must survive erasure (`V33-DEC-024` ledger reasoning); export returns the customer's own decision amounts and instants, never the reviewer or seller user ids |
| `booking.no_show_declarations` | `subject_data` (both parties) | statement authored by the professional about the customer's booking; export to the customer returns instant and statement, to the professional their own row; erasure of either party anonymises `statement` to a fixed marker and keeps the instant and money consequence |
| `dispute.cases`, `dispute.case_statements`, `dispute.case_evidence_requests` | `subject_data` (both parties) | each party's export returns their own statements and the case's outcome fields, never the other party's identifiers beyond the booking they already share, never reviewer ids; erasure anonymises that party's statements, deletes their evidence objects, and keeps decisions |
| `dispute.case_decisions` | `retained` | adjudication history with reviewer ids; erasure of a reviewer keeps the row (obligation), export to parties omits the id |

**Protected evidence.** A file may exist for a case **only** after a `request_more_information` decision (`case_evidence_requests` row with its reason). It is uploaded through `libs/media` under a new purpose `dispute_evidence` at `accessClass: 'protected'`, with `canView` true only for the submitting party and a holder of `bc_review_disputes` with live revocation; no thumbnail, no derivative, no public URL. It is deleted (object and row `deleted_at`) at case closure plus `case_file_retention_days` from the order's terms row. **When that value is NULL — i.e. no administrator has published a Legal-approved retention period — `request_more_information` is refused**, so no sensitive file can be created before the retention obligation is known. This ADR chooses no duration.

**Audit.** Every privileged action (publication, evidence record, dispute decision) writes an admin audit row in its own transaction; every party action (selection, acceptance, declaration, filing, choice) writes an ordinary audit log line and a booking/dispute history row; no log, metric label, error message or trace carries a statement body, a reviewer id, a `workspaceRef`, or an evidence reference.

---

## Transaction and lock ordering (binding across the family)

| Operation | Order of acquisition | Linearization point |
|---|---|---|
| Publish outcome/copy version (`#42a`) | family row `FOR UPDATE` → version insert/update → evidence check (trigger) → audit | exclusion constraint on the window; lifecycle trigger |
| Record / retire Legal evidence (`#42a`) | evidence row `FOR UPDATE` (retire) → audit | `evidence_key UNIQUE`; forward-only status trigger |
| Seller selection (`#42b`) | current assignment `FOR SHARE` → family version read at `now()` → new row → supersede old (CAS on `superseded_by_id IS NULL`) → audit | partial unique index (ADR-048 §4 pattern) |
| Checkout (`#42b`) | existing order: booking create → order → schedule → **terms resolve → `order_outcome_terms` insert → `policy_accepted_at`** → entitlement hook → confirm/redirect (ADR-044/ADR-050 order unchanged; the new writes sit between schedule and entitlement) | order PK; checkout idempotency key |
| Cancellation decision (`#42c`) | `BookingCancelled` consumer: order `FOR UPDATE` → terms/evidence read → decision insert → commit → execute refund | `UNIQUE (booking_id, decision_kind) WHERE superseded_by_id IS NULL` |
| Reschedule consequence (`#42c`) | booking `FOR UPDATE` (existing) → order `FOR UPDATE` → decision insert → slot claim → move → commit | same unique index; existing CAS on `reschedule_count` |
| No-show declaration (`#42d`) | booking `FOR UPDATE` → grace check in SQL → declaration insert → transition → event → commit | `booking_id UNIQUE` on declarations |
| Window sweep / lazy evaluation (`#42d`) | declaration `FOR UPDATE SKIP LOCKED` (sweep) or `FOR SHARE` (lazy) → order `FOR UPDATE` → decision insert → state forward | decision unique index; both paths converge |
| Remedy choice (`#42d`) | choice row `FOR UPDATE` → (reschedule: booking `FOR UPDATE` → claim → move) or (refund: execute) | `order_id PK` |
| Dispute filing (`#42e`) | booking `FOR SHARE` → eligibility read → case insert → declaration/decision state forward → audit | `booking_id UNIQUE` on cases |
| Dispute decision / appeal (`#42e`) | case `FOR UPDATE` → decision insert (triggers: stage unique, different reviewer) → superseding outcome decision (§6) → audit → commit → execute | `UNIQUE (case_id, stage)`; the reviewer trigger |

No operation takes the `bcre` or `bcgv` advisory locks; where a path already holds them (confirmation), this ADR adds no acquisition inside it. Every cross-module read goes through a composition-root port with `manager` passed explicitly (ADR-048 §1).

## Failure semantics

- Missing publication, member no longer allowed, no active copy, mismatched acceptance → **generic refusal**, nothing written (selection / checkout).
- Missing terms row, absent or retired Legal evidence, NULL cap → **full refund**, decision row records the reason (decision time). A cancellation is never blocked by policy.
- Refund `manual_required` / `failed` → decision stays, `execution_status` says so, retry re-calls with the same key.
- Sweep crash mid-batch → per-booking transactions; the next run or a lazy read finishes the rest.
- Trigger refusal (cap without evidence, appeal by the same reviewer, backward state) → the whole transaction rolls back and the caller receives the generic refusal; no partial row survives.
- Unknown field on any new DTO → `400`, as the existing validation pipeline does.

## Concurrency invariants (each proved in the matrix below)

1. At most one live decision per `(booking_id, decision_kind)`.
2. At most one declaration, one case and one remedy choice per booking/order.
3. One refund per `(order_id, request_key)`; the key is booking-derived and unchanged from today.
4. One credit return per booking (existing seam).
5. Two reviewers cannot both decide the same stage; the same reviewer cannot decide both stages.
6. A version cannot be published with a cap and without recorded evidence, under any interleaving.
7. A `legacy_unenrolled` order can never acquire a terms row after creation.

## Migration ordering

1. `#42a`: `commercial.legal_evidence_records` → `booking_outcome_policies` / `_versions` / `_retention_options` (FK to evidence) → `customer_policy_copies` / `_versions` → lifecycle and evidence triggers → subject-data claims → **no seed**.
2. `#42b`: `commercial.seller_outcome_policy_assignments` → `commerce.order_outcome_terms` (FK to orders) → append-only trigger → claims. `order_payment_schedules` is **not altered**.
3. `#42c`: `commerce.booking_outcome_decisions` → partial unique index → append-only trigger → claims. No change to `commerce.orders` columns or constraints.
4. `#42d`: `booking.no_show_declarations` → `commerce.customer_remedy_choices` → numeric family gains `remedy_choice_window_hours NULL` (additive, no rewrite) → claims.
5. `#42e`: schema `dispute` and its four tables → reviewer trigger → `dispute_evidence` media purpose → claims → capability list.

Every migration is additive; each is proved clean from an empty database and idempotent against an already-applied one; none rewrites an existing row; none drops anything. Removal of the v1 outcome contract (§2) and of the two `BookingConfig` getters (§6) happens only after their last consumer is proved gone.

## Reversibility, and the facts that are not reversible

Reversible: any published version can be superseded forward; a seller can re-select; an evidence record can be retired; a media purpose can be closed. **Not reversible:** a written acceptance fact, a decision row, a declaration, a case decision and an executed refund are permanent facts by construction (append-only triggers); a retired evidence record cannot be un-retired (a new one is recorded instead). Rolling back a child story leaves its tables in place, empty or historical, and never reinterprets an earlier booking.

## Requirement-to-test matrix (`#42a`–`#42e` each carry their rows; every "probe" is a mutation probe that must fail when the guard is removed)

| Req | Proof | Owner |
|---|---|---|
| §1 lifecycle, exclusion window, non-retroactivity, immutability of published versions | real-PostgreSQL: overlapping window `23P01`; backdated activation CHECK; UPDATE of a published row refused by trigger | `#42a` |
| §1 no hard-coded value | exact-set test that no migration/seed creates a version; boot with empty families; probe: a planted seed fails the test | `#42a` |
| §5 cap unwritable without evidence | probe: INSERT published version with `legal_cap_kind` and NULL/retired/other-subject evidence → trigger refusal; with valid evidence → succeeds | `#42a` |
| §5 privacy | export for a customer, a seller and the recording admin returns no evidence row; no response includes it | `#42a` |
| §3 selection inside range; binds key not version; re-range forward | member outside the active version refused; version superseded → new booking fails closed until re-selection; existing bookings untouched | `#42b` |
| §3/§4 snapshot immutability and same-transaction acceptance | rollback of the order leaves no terms row and NULL `policy_accepted_at`; replay with the idempotency key writes nothing new; mismatched `acceptedPolicy` refuses | `#42b` |
| §4 no fabricated acceptance | probe: omit `acceptedPolicy` → refusal; `legacy_unenrolled` keeps NULL | `#42b` |
| §3 `workspaceRef` byte-identical; `business_staff` grants nothing | golden vectors unchanged; staff session receives the generic refusal | `#42b` |
| §6 boundary timely on the DB clock | freeze DB time at exactly `slotStart − cutoff` → timely; one microsecond later → late | `#42c` |
| §6 arithmetic | property test over `bp`, amounts and caps: BigInt floor; `retained + refund = collectedRemaining`; never exceeds `ck_orders_refund_within_collected` | `#42c` |
| §6 fail-closed | probes removing each of terms row / cap / evidence / selection → full refund; `deposit-capture-accounting.pg-spec.ts:502` still green for un-snapshotted orders | `#42c` |
| §6 one decision, one refund | concurrent duplicate `BookingCancelled` delivery → one row, one refund (existing key); replay after `manual_required` → no second row | `#42c` |
| §6 reschedule consequence | free count honoured; post-cutoff preview returns the consequence before the move; un-snapshotted booking keeps `too_close`/`max_reached` | `#42c` |
| §7 guard | declaration at `slotStart + grace − 1s` refused, at `+ grace` accepted (DB clock); un-snapshotted booking keeps the `slot_end` rule | `#42d` |
| §7 no money, no medical field | declaration writes no refund/decision/ledger row; DTO rejects `photo`, `location`, `notes.medical` | `#42d` |
| §7 window convergence | sweep and lazy read racing → one `no_show` decision; a filed dispute stops both | `#42d` |
| §7 credit return | `admin` cancellation returns the credit once; `customer` returns nothing | `#42d` |
| §8 choice | `reschedule` bypasses cutoff and count; second choice → existing resolution; refund default when `remedy_choice_window_hours` NULL executes immediately; no double refund/return | `#42d` |
| §9 eligibility and window | timely cancellation, foreign booking, closed case, late filing → the same refusal byte-for-byte; `bodily_harm` extends the window and stores only the category | `#42e` |
| §9 hold | while open: executor skips; no release fact; `held_toman` immutable | `#42e` |
| §9 appeal by different reviewer | probe: same user on both stages → trigger refusal; two reviewers racing the same stage → one row | `#42e` |
| §9 reviewer hidden; history immutable | party projections lack ids; UPDATE on decisions/statements refused | `#42e` |
| §10 evidence | request refused when retention NULL; file visible only to submitter and reviewer; deleted at closure + period; erasure deletes the party's objects | `#42e` |
| §10 dispositions | ADR-027 coverage boot assertion; export/erasure per table as specified | each |
| Non-enumeration timing | measured comparable timing across refusal causes under the `V33-DEC-033` method | `#42b`, `#42e` |

## Considered and rejected (family-level)

| Alternative | Rejected because |
|---|---|
| Reuse `BookingCommercialTermsV1` | §2 — seven structural contradictions with the ratified policy and an all-fields-required validator |
| One story per code layer (schema, service, routes, tests) | `V33-DEC-043`'s split is by testable outcome; a layer story delivers nothing a customer or seller can observe |
| Evaluate in `BookingService` | inverts ADR-039's boundary and would put money arithmetic in the scheduling domain |
| Application-clock arithmetic | contradicts `V33-DEC-039` R4/R14; the booking service's `new Date()` stays for `cancelled_at` display only |
| Boolean "Legal approved" on the version | §5 — unattributable and unretirable |
| Business owner/manager declaring no-show or cancelling for a practitioner | not authorized by any ratified decision; `V33-DEC-030` deferred delegated calendar authority; `V33-DEC-043` restates the professional-session boundary |
| Invent a remedy-choice deadline | no ratified value; §8 makes it an administrator-published nullable value with immediate default |
| Store the Legal opinion or a retention duration | outside the owner's authority and the platform's need |
| A fourth advisory-lock namespace | row locks in the fixed order suffice; ADR-050's order is respected without it |

## Consequences

- Positive: five independently provable stories with one fixed design; every Legal-dependent value is structurally unwritable without a referenced attestation; today's full-refund behaviour is preserved byte-for-byte for every booking without a terms row.
- Negative, disclosed: two more policy families and one more module (`dispute`) to operate; the v1 outcome contract lingers until its last consumer is removed; the `dispute` module needs read ports into booking and commerce and a third subject-data contract.
- Negative, disclosed: `#42d`'s sweep is a second periodic job next to `expireStaleHolds`; both are per-booking transactions and share the same operational posture.

## Rollout and non-activation boundary

Every mechanism above ships **disabled by absence**: with no published numeric family, copy family, evidence record or seller selection, no booking acquires a terms row and every path behaves exactly as at `57448ff`. Publishing a version changes what a *new* booking records; it moves no money until `#42c`'s evaluator exists, and even then retention is zero until a `legalCap` referencing recorded evidence is published. Production activation of retention, no-show penalties, evidence files and real refunds remains gated by the external facts named on #42 (`gate:legal`) and #47 (`gate:external`); nothing in this ADR records that any of them exists.

## Non-goals

No commission, allocation, availability, release or settlement (`V33-DEC-040`, #43); no provider, adapter, credential or real-money rail (`V33-DEC-041`, #47); no paid credit activation or credit refund (#99); no delegated calendar authority; no medical or health data; no external arbitration; no frontend implementation; no Persian sentence as approved legal text; no published value of any kind; no deployment, tag or Release.

## Mechanism-to-child map

| Section | `#42a` | `#42b` | `#42c` | `#42d` | `#42e` |
|---|---|---|---|---|---|
| §1 families | **owns** | reads | reads | reads (`remedy_choice_window_hours` additive column) | reads |
| §2 supersession | records | **introduces the new contract** | consumes | consumes | may remove v1 outcome fields (conditional) |
| §3 selection + snapshot | — | **owns** | reads | reads | reads |
| §4 acceptance | — | **owns** | — | — | — |
| §5 Legal evidence | **owns** | — | reads at decision time | — | — |
| §6 evaluator + decisions | — | — | **owns** | invokes | supersedes via `dispute_outcome` |
| §7 no-show | — | — | — | **owns** | reads |
| §8 remedy choice | — | — | — | **owns** | — |
| §9 disputes | — | — | — | — | **owns** |
| §10 dispositions/evidence | own tables | own tables | own tables | own tables | own tables + media purpose |

#43, #47 and #99 remain separate stories with their own decisions; this ADR consumes none of their scope and creates none of their facts.

## Open gates

- `gate:legal` on `#42a`, `#42c`, `#42e`: the lawyer's written opinion (withdrawal posture, retention terminology and cap), Legal/privacy review of the published copy and of the case-file retention period — all to be recorded through §5's mechanism by a person, never inferred.
- #47: any real refund, partial refund or reversal.
- #43: the pending/available/disputed ledger states that will consume §6/§7/§9 facts.
- The delegated-calendar decision `V33-DEC-030` deferred, should a business owner ever need to act for a practitioner.
