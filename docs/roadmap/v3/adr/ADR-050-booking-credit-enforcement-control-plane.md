# ADR-050 — Booking-credit enforcement has a persistent four-plane control plane, and global activation is a separate story from the controls it needs

**Status:** Accepted — 2026-09-11
**Approver:** product owner (`V33-DEC-036` ratified 2026-09-11)
**Backlog:** #95 (`#58b-1`, the control foundation) and its activation child (`#58b-2`, created by the same governance change; see `V33-DEC-036` for the assigned number)
**Constrains:** #95 (`#58b-1`), `#58b-2`; leaves #58 (`#58a`) unchanged
**Binding authorities:** [`V33-DEC-007`](../../v3.3/V3.3_DECISION_REGISTER.md) (four independent controls), [`V33-DEC-009`](../../v3.3/V3.3_DECISION_REGISTER.md) (no allowance as a constant, default, fallback or seed), [`V33-DEC-010`](../../v3.3/V3.3_DECISION_REGISTER.md) (consumption, return and zero balance), [`V33-DEC-025`](../../v3.3/V3.3_DECISION_REGISTER.md) (the `#58a`/`#58b` split, dormant versus exhausted), [`V33-DEC-028`](../../v3.3/V3.3_DECISION_REGISTER.md) Rulings 10 and 11 (the corrected premise and the rollout treatment) and [`V33-DEC-036`](../../v3.3/V3.3_DECISION_REGISTER.md) (R1–R14, the owner ratification this ADR records). None is reopened, re-decided or weakened here.
**Depends on:** [ADR-039](ADR-039-commercial-policy-control-plane.md) §2 (the four controls), [ADR-041](ADR-041-commercial-plan-and-price-catalogue.md) (the versioned catalogue and the privileged administrator surface), [ADR-042](ADR-042-seller-subscription-foundation.md) (the ownership-only seller party and its resolver), [ADR-046](ADR-046-booking-credit-accounting.md) (the immutable ledger, dormant versus exhausted, the per-party advisory lock and the confirmation-wide port), [ADR-048](ADR-048-booking-collection-policy-publication-and-assignment.md) (the pattern of presence-as-enrollment and `FOR SHARE` linearization it established for collection policy), [ADR-027](ADR-027-subject-data-contract.md) (subject-data coverage), [ADR-018](ADR-018-cross-domain-consistency.md) (same-cluster consistency), [ADR-011](ADR-011-repository-architecture.md) (module boundaries)

**This ADR is the mandatory pre-code gate `V33-DEC-036` requires.** It is committed alone, as the first commit of its own governance pull request, containing exactly one new file. It writes no schema, no migration, no route, no DTO, no service, no controller, no contract, no event, no capability, no index, no seed and no test. It activates no rollout, provider, payment, price, allowance or entitlement, and it is **not Legal approval**. **No production code or schema for anything described below exists yet.**

**Amended 2026-09-11 (Story #95 implementation) — the position of the control-row read in the lock order.** §4.2 and §7.2 as accepted placed the control row `FOR SHARE` *after* the `bcre` party lock on the confirmation path. That order is unimplementable without violating R13: the party lock is taken *inside* `consumeForConfirmation` (`booking-credit-accounting.service.ts:148`), which this story may not edit, so the seam's read necessarily precedes it. The implemented order — and the one every other operation now follows — is **`bcgv` → order row → booking row → control row → `bcre` party lock → domain rows**: the confirmation reads the control row `FOR SHARE` after the order lookup and before the ledger; transition and exemption take `bcgv` shared, then the control row `FOR SHARE`, then `bcre` per party in `(party_type, party_id)` order; the kill switch takes the control row `FOR UPDATE` alone; preview takes nothing. The deadlock analysis is unchanged in substance: every operation acquires the two contended objects (control row, `bcre`) in the same order, the two `FOR SHARE` readers are compatible with each other, and the only cross-path edge is a `FOR UPDATE` waiting behind `FOR SHARE` — a wait, never a cycle. The original sentences in §4.2 and §7.2 are preserved below and read with this correction. This is an engineering consistency correction inside the ratified `V33-DEC-036` structure; it changes no ruling, no schema and no outcome.

**Amended 2026-09-12 (Story #141 implementation) — six engineering consistency notes, inside the ratified structure.** A read-only readiness audit of #141 against `aa3833047f2853278e4536f739907bb5bbfd7236` found six places where the prose below and the merged #95 code could not both be satisfied literally; each was resolved by the rule that follows from a binding ruling, none changes a ruling, a schema, a constraint, a trigger or a customer-visible outcome, and the original sentences are preserved unchanged. **(1) Governance is read under the `bcre` party lock (§4.1) without editing `consumeForConfirmation` (R13):** the confirmation seam itself takes the same transaction-scoped advisory lock — `pg_advisory_xact_lock(bcre, hashtext('<type>:<id>'))`, spelled once in `booking-entitlement-party-lock.ts` and shared with the transition command — *before* its governance read; the ledger's own acquisition a moment later is re-entrant within the session, so the implemented confirmation order is **order row → control row `FOR SHARE` → `bcre` party lock → governance read → ledger**, the amendment above's order with the governance read placed exactly where §4.1 says. **(2) `business_policy_disabled` for an unresolved party (§4.3 row 8) is decided by the seam, not by `CommercialPolicyControlGate.decide`:** the gate evaluates entitlement before business policy, so with the ledger honestly unevaluated it can only answer `entitlement_missing`; the seam therefore resolves the business-policy plane from the governance row first, refuses an unresolved or malformed party without consulting the ledger, and calls the gate with every plane genuinely evaluated only for a governed party once `#58a` has answered. The gate's ordering is unchanged. **(3) The activation command reads the singleton `FOR UPDATE` with a raw statement and updates it with one statement** (`rollout_state`, `activation_generation + 1`, `activated_at = now()`, `activation_audit_id`), the kill-switch columns untouched; the kill-switch state is not a precondition (R2: activation never bypasses the switch). **(4) `AdminAuditService.recordSystem` resolves to the persisted row's id** (additive, as `record` did for #95), because the creation hook's governance row must point at the system audit row written in the same transaction. **(5) The §3.4 port is two type-specific methods, one adapter:** `SellerGovernanceInitializationPort.initializeProfessionalGovernance(manager, professionalId)` in `services/provider` and `BusinessGovernanceInitializationPort.initializeBusinessGovernance(manager, businessId)` in `services/business`, bound in `apps/api` under `SELLER_GOVERNANCE_INITIALIZATION` / `BUSINESS_GOVERNANCE_INITIALIZATION` to one `EnforcementBackedGovernanceInitialization` — the `IdentityBackedOwnerRoleGrant` arrangement — because the caller is the only thing that knows the party type and a raw id must not be used to infer it. **(6) The closed audit vocabulary has six actions, not seven:** §5.2's five plus `commercial.enforcement_party_governed_at_creation`, the `actor_label = 'system'` action of the creation hook that §3.4 required and §8 left unnamed. Two consequences for the test harness, disclosed: the real-PostgreSQL fixture now returns the singleton to its seeded state by `TRUNCATE` + reseed (a row trigger fires on neither, so `tg_bcec_protect` is untouched and still refuses `active → inactive` for every UPDATE), and the #95 story-boundary pins that asserted the *absence* of activation, the reserved cause, the exclusive `bcgv` form and the seventh route were replaced by pins asserting each is present *exactly once*.

**How to read the rules below.** Each is marked **Today** — a fact already true of the merged repository, verified against `2cf217098fdc93e0d1f084f5837b42222c716c63` before this ADR was written — or **Obligation (`#58b-1`)** / **Obligation (`#58b-2`)** — something the named child must make true before its own code is complete. Nothing below claims that a planned table, column, route, lock or test already exists.

---

## Context

### What #95 was asked to do, and what was missing

`V33-DEC-025` split #58 into `#58a` — the accounting foundation with **selective** enforcement, shipped — and `#58b` (#95), the later global switch. `V33-DEC-028` Ruling 10 corrected #95's premise (a positive grant source is already reachable through an administrator-published zero-price plan version) and fixed its rollout treatment: no synthetic backfill, existing `D-7` sellers stay legacy-exempt until explicitly transitioned, a fail-closed activation that refuses while any eligible seller remains unintentionally legacy-exempt, a non-mutating preview and count, and a persistent audited emergency kill switch. Ruling 11 required the four control planes `CommercialPolicyControlGate` models to **persist and compose** before global enforcement, and its "Next ADR" section assigned that persistence and composition to **ADR-048**.

**ADR-048 did not fulfil that obligation, and this ADR says so plainly.** ADR-048 was written for #83 (`V33-DEC-029`) and specifies collection-policy publication, assignment and order snapshotting. It contains no control-state table, no kill-switch persistence, no rollout state, no governance fact for a seller and no composition of the four planes; its only mentions of #95 are as a non-goal. ADR-039's 2026-09-06 amendment therefore still points at an ADR that never took the assignment. A read-only readiness audit of #95 on 2026-09-11 found the consequences:

| Finding | Where |
|---|---|
| `CommercialPolicyControlGate` is a pure function with **no production caller** | **Today** — `services/commercial-policy/src/commercial-policy-control.gate.ts`; the only importer outside the module is its own spec |
| None of the four flags it evaluates is persisted anywhere | **Today** — no table, column or env var carries a rollout state, a kill-switch state or a governance fact |
| No command, route, CLI or service can preview, transition, activate or engage a kill switch | **Today** — `v1/admin/commercial` (`commercial-catalogue.controller.ts:72`) exposes plans, schedules and collection policies only |
| #95's own non-goal — *"No new HTTP surface, commercial event or `ServiceName`"* — makes every operation it requires unreachable | #95 body, "Boundaries and non-goals" |
| A 5-SP estimate covered persistence, preview, transition, kill switch, activation, concurrency, audit, privacy and production gates | #95 body, "Story-point estimate" |

`V33-DEC-036` resolved all of it: a split into a control **foundation** and an **activation** child, a persistent schema shape, a corrected operational surface, platform-wide kill-switch semantics, a PostgreSQL-authoritative locking scheme, an eligibility definition checked against the real lifecycle, and privacy and audit dispositions. This ADR records those decisions as engineering rules.

### What already exists and is not redesigned

| Fact | Where |
|---|---|
| Balance is derived from immutable grants minus consumptions plus returns; one consumption per booking (`uq_bcc_booking_once`); one return per consumption; both tables reject `UPDATE`/`DELETE` by trigger | **Today** — ADR-046 §1; `commercial/20260906800001_create_booking_credit_accounting.sql` |
| Dormant (`not_configured`) and exhausted (`insufficient_credit`) are answered by two different questions | **Today** — `booking-credit-accounting.service.ts:174-179` |
| Balance decisions are serialised per snapshotted party by `pg_advisory_xact_lock(BOOKING_ENTITLEMENT_LOCK_NAMESPACE, hashtext('<type>:<id>'))`, namespace `0x62_63_72_65` (`bcre`) | **Today** — `booking-credit-accounting.service.ts:37,148-151` |
| One confirmation-wide port, `BookingConfirmationEntitlementHook.onBookingConfirmation(manager, bookingId)`, bound in `apps/api` and invoked from **both** checkout paths inside the caller's transaction | **Today** — ADR-046 §3; `apps/api/src/composition/booking-credit-entitlement.adapter.ts`; `checkout.service.ts:343` |
| The charged party is the order's immutable `seller_party_type`/`seller_party_id` | **Today** — ADR-046 §7; adapter lines 47-54 |
| The seller party is ownership-only: `provider.professionals.owner_id` / `business.businesses.owner_id`, `deleted_at IS NULL`, `verification_status` deliberately **not** consulted, staff affiliation grants nothing, a user may own both | **Today** — ADR-042 §3; `port-adapters.ts:236-291` (`OwnershipBackedSubscriberPartyResolver`) |
| Owner roles are granted at seller creation through a **mandatory transaction-scoped composition port** (`SellerOwnerRoleGrantPort`, `BusinessOwnerRoleGrantPort`) on the creating transaction's own manager | **Today** — `provider.service.ts:67-100`; `provider/src/ports.ts:96`; `business/src/ports.ts:46`; `V33-DEC-021` |
| `admin.admin_audit_log` is the platform audit trail — `actor_user_id` XOR `actor_label`, closed `action`, `target_type`/`target_id`, `before_state`/`after_state`, `reason`; INSERT/SELECT only for the application role | **Today** — `admin/20260824100002_create_admin_audit_log.sql:31-75`; ADR-042 §10 |
| Every administrator mutation on `v1/admin/commercial` is class-gated on the privileged `bc_manage_commercial_plans`, live-rechecked, requires a mandatory `reason` (3–500 chars, trimmed) and is audited in the same transaction | **Today** — `commercial-catalogue.controller.ts:37-73`; `commercial-catalogue.dto.ts:58-67`; `PRIVILEGED_CAPABILITIES` |
| The global `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true` | **Today** — `apps/api/src/main.ts:82-83` |
| Every existing advisory-lock namespace: `aicn`, `bkas`, `srrq`, `bcre`, `wish` | **Today** — grep of `_LOCK_NAMESPACE =` across `services/**` |

### What the verification lifecycle actually is — the R11 check

`V33-DEC-036` R11 recommended that verification-suspended or revoked parties "cannot create a new commitment", and instructed that the recommendation be checked against the real schema and reported rather than recorded if the reachable states contradict it. They do, in two ways, so the recommendation is **not recorded as a rule**:

1. `suspended` and `revoked` exist in `VERIFICATION_STATUSES` and in `ProviderService`'s transition table (`provider.service.ts:23-30`), but **no production route produces either**. The only callers of `transitionVerification` are `verification.service.ts:122` (to `pending`) and `:294` (to `verified` or `rejected`). `business.businesses.verification_status` is written once, as `'unverified'`, at creation (`business.service.ts:54`) and never transitioned by any code.
2. **No confirmation path consults `verification_status` at all** — not `booking.service.ts`, not `checkout.service.ts`, not the entitlement adapter. A suspended professional, were one ever to exist, can be confirmed against today. Making verification gate confirmation would be a new behaviour outside #95's scope, not a consequence of it.

What survives of R11's intent is recorded in §3: verification status is **orthogonal** to eligibility and to governance, exactly as it already is to the subscriber party. A governed party stays governed through any verification transition because governance is keyed by party id and is monotonic; a party is never "restored" into an ungoverned state because nothing removes its governance fact. If a later decision makes verification gate confirmation, it composes above the entitlement seam and changes nothing here.

---

## Decision

### 1. Two stories, one contract

**R1 (`V33-DEC-036`).** The #95 family is split into two independently testable children and re-estimated **5 → 10 SP**:

| Child | Number | SP | Status | Owns |
|---|---|---:|---|---|
| `#58b-1` — Booking-credit enforcement control foundation | #95 (number kept) | 5 | `status:ready` | the two control tables (§2), the eligibility and governance predicates (§3), the privileged administrator sub-resource for **preview, explicit governance transition and kill-switch engage/release** (§5), kill-switch semantics (§6), the composition seam that reads the planes (§4) **without changing any confirmation outcome while rollout is inactive**, audit and privacy (§8), and the tests in §10 that belong to it |
| `#58b-2` — Global booking-credit activation and enforcement | assigned by GitHub at creation | 5 | `status:proposed`, depends on #95 | the atomic activation command (§7), the seller-creation race closure (§3.4), and the change of the global confirmation path so that a governed party is fail-closed (§4.3) |

The foundation is independently valuable: after it ships, an operator can see exactly who is eligible, governed, intentionally exempt and unresolved; can transition sellers; can engage and release the kill switch under a real incident; and every one of those facts survives a restart — while **no seller's confirmation outcome changes**, because the rollout plane stays `inactive` and nothing in the foundation flips it.

### 2. Persistent schema — Obligation (`#58b-1`)

Both tables live in the `commercial` schema, owned by `services/commercial-policy`, in one new migration under `database/migrations/commercial/` with the next timestamp after `20260916100001`. No column anywhere carries a commercial number, allowance, price, quantity or policy parameter.

#### 2.1 `commercial.booking_credit_enforcement_control` — the singleton

| Column | Type | Rule |
|---|---|---|
| `id` | `SMALLINT PRIMARY KEY` | `CONSTRAINT ck_bcec_singleton CHECK (id = 1)` — PostgreSQL, not the application, makes a second row unrepresentable |
| `rollout_state` | `VARCHAR(16) NOT NULL` | `CONSTRAINT ck_bcec_rollout_state CHECK (rollout_state IN ('inactive', 'active'))` |
| `activation_generation` | `INTEGER NOT NULL DEFAULT 0` | `CHECK (activation_generation >= 0)`; incremented by exactly one on each activation |
| `activated_at` | `TIMESTAMPTZ NULL` | database clock (`now()`) at activation, never client-supplied |
| `activation_audit_id` | `UUID NULL` | the `admin.admin_audit_log.id` written in the activating transaction; **opaque, no cross-schema FK** (`V3_DATABASE_BLUEPRINT.md` §1) |
| `kill_switch_state` | `VARCHAR(16) NOT NULL DEFAULT 'released'` | `CONSTRAINT ck_bcec_kill_switch_state CHECK (kill_switch_state IN ('released', 'engaged'))` |
| `kill_switch_changed_at` | `TIMESTAMPTZ NULL` | database clock of the last engage/release |
| `kill_switch_audit_id` | `UUID NULL` | the audit row of that last change; opaque |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Valid-state constraints, all named:

- `ck_bcec_activation_consistent`: `(rollout_state = 'inactive' AND activated_at IS NULL AND activation_audit_id IS NULL AND activation_generation = 0) OR (rollout_state = 'active' AND activated_at IS NOT NULL AND activation_audit_id IS NOT NULL AND activation_generation >= 1)`.
- `ck_bcec_kill_switch_consistent`: `(kill_switch_changed_at IS NULL) = (kill_switch_audit_id IS NULL)`, and `kill_switch_state = 'engaged'` implies `kill_switch_changed_at IS NOT NULL`.

Immutability, by trigger in the shape `commerce.reject_order_payment_schedule_rewrite()` established: `DELETE` is refused; an `UPDATE` that moves `rollout_state` from `active` to `inactive`, or decrements `activation_generation`, or changes `activated_at`/`activation_audit_id` once set, is refused. The kill-switch columns are the only ones an ordinary transaction may move in both directions.

**The migration inserts the one row** — `id = 1`, `rollout_state = 'inactive'`, `activation_generation = 0`, `kill_switch_state = 'released'`. That is the control's initial safe state and a structural precondition of every reader below (an absent row is a malformed state that fails closed, §9); it is **not** a commercial value and it activates nothing. **Why actor identity is not on this row (R12):** the administrator who activated or who last moved the kill switch is fully recorded in `admin.admin_audit_log`, and the two `*_audit_id` columns point at those rows. Duplicating `actor_user_id` here would make the singleton carry subject data for no load-bearing reason; without it, the row honestly carries none.

#### 2.2 `commercial.booking_credit_party_governance` — the per-party fact

| Column | Type | Rule |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | uuidv7 |
| `party_type` | `VARCHAR(16) NOT NULL` | `CONSTRAINT ck_bcpg_party_type CHECK (party_type IN ('professional', 'business'))` — the same vocabulary as `seller_subscriptions.subscriber_party_type` |
| `party_id` | `UUID NOT NULL` | opaque; references `provider.professionals.id` or `business.businesses.id` with **no cross-schema FK**, exactly as the subscription tables do |
| `state` | `VARCHAR(16) NOT NULL` | `CONSTRAINT ck_bcpg_state CHECK (state IN ('legacy_exempt', 'governed'))` — see §3.2 for the meaning of each |
| `cause` | `VARCHAR(32) NOT NULL` | the **closed reason** R3 requires: `CONSTRAINT ck_bcpg_cause CHECK (cause IN ('explicit_transition', 'explicit_exemption', 'created_under_enforcement'))`, with `ck_bcpg_cause_state` binding `explicit_exemption` to `legacy_exempt` and the other two to `governed` |
| `proof_grant_id` | `UUID NULL REFERENCES commercial.booking_credit_grants (id)` | the positive immutable grant that proved the party's published entitlement at an **explicit** transition (§3.3); `ck_bcpg_proof` requires it `NOT NULL` when `cause = 'explicit_transition'` and `NULL` otherwise. Same schema, so a real FK is permitted and used |
| `recorded_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | database clock of the row's creation |
| `governed_at` | `TIMESTAMPTZ NULL` | database clock of the transition to `governed`; `ck_bcpg_governed_at` requires it `NOT NULL` exactly when `state = 'governed'` |
| `recorded_by_user_id` | `UUID NULL` | the administrator who wrote the current state; XOR with the next column |
| `recorded_by_label` | `VARCHAR(40) NULL` | `'system'` for `created_under_enforcement`; `CONSTRAINT ck_bcpg_actor CHECK ((recorded_by_user_id IS NOT NULL AND recorded_by_label IS NULL) OR (recorded_by_user_id IS NULL AND recorded_by_label IS NOT NULL))`, the `ck_admin_audit_actor` shape |
| `audit_id` | `UUID NOT NULL` | the `admin.admin_audit_log.id` of the write that produced the current state; opaque |

Keys and indexes: `CONSTRAINT uq_bcpg_party UNIQUE (party_type, party_id)` — one row per party, ever; `ix_bcpg_state ON (state)` for the preview aggregates.

**Why actor columns are on this row and not on the singleton (R3.B, R12).** `V33-DEC-036` R12 names this table as the one that "carries subject-linked party and actor facts and is retained as an operational/legal obligation". The load-bearing reason is that the governance fact must be self-describing to the domain that reads it: `services/commercial-policy` may not read `admin.*` (ADR-011; the application role holds INSERT and SELECT on the audit log, but the audit log belongs to `identity`'s admin module, not to commercial policy), and "which administrator put this seller under the regime, and when" is part of the seller's own record, not only of the platform's audit trail. The `_user_id` suffix also makes ADR-027's `wrongly_declared_empty` detector fire on any dishonest `no_subject_data` claim (§8).

**Immutability and monotonicity, by trigger.** `DELETE` is refused. Exactly one `UPDATE` shape is permitted: `state` from `legacy_exempt` to `governed`, in the same statement setting `cause`, `governed_at`, `proof_grant_id`, `recorded_by_*` and `audit_id`; every other column change, and every transition out of `governed`, is refused. `V33-DEC-036` R3: an ordinary administrator cannot return a governed seller to legacy-exempt; emergency containment is the kill switch, never deletion of a governance row. The full transition history lives in `admin.admin_audit_log` (`before_state`/`after_state`), so no second history table is created (R3.C).

**Why `state` exists rather than presence-only.** ADR-048 R2 made assignment presence the enrollment fact because it had one state. This table has **two** explicit facts an operator can record — *governed* and *intentionally legacy-exempt* — and both must be durable, so the row's presence means "resolved" and `state` says how. Absence means "unresolved" (§3.2).

### 3. Eligibility, governance and the four states of a seller

#### 3.1 Eligible seller party — Obligation (`#58b-1`), reusing Today's predicate

An **eligible seller party** is exactly a row of `provider.professionals` with `deleted_at IS NULL`, or a row of `business.businesses` with `deleted_at IS NULL`. Nothing else:

- `owner_id` is `NOT NULL` on both tables, so every such row is owner-backed by construction;
- `verification_status` is **not** part of the predicate (Context, "the R11 check");
- `business_staff` affiliation grants nothing: a staff member's employer is the employer's party, never the staff member's, and a professional who is also staff is eligible **as a professional** only;
- a user owning both a professional and a business yields **two** independent parties, each with its own governance row (ADR-042 §3);
- the subscription state is **not** part of eligibility. A seller with no subscription row (possible only for a party created before the `D-7` backfill and never initialised, or in a test) is still eligible and still needs a governance decision;
- a deleted party is ineligible, and its governance row — if any — is retained (§8). Because `uq_professionals_owner_id` is unconditional, a professional party id is stable for the life of the user; a business soft-deleted and re-created is a **new** party (`V33-DEC-030` D3's partial index) and gets its own governance row through §3.4.

This is `OwnershipBackedSubscriberPartyResolver.isEligible` applied set-wise. `#58b-1` must express it **once**, as one SQL predicate (or one query-builder fragment) shared by preview, explicit transition, activation and the creation hook — a second copy is the drift `V33-DEC-036` R6 and R9 forbid, and the test in §10 that mutates one copy exists to prove there is only one.

#### 3.2 The four resolution states — Obligation (`#58b-1`)

For an eligible party, exactly one of the following holds, read from `booking_credit_party_governance`:

| State | Meaning | Confirmation outcome while rollout is `inactive` | Confirmation outcome once rollout is `active` (`#58b-2`) |
|---|---|---|---|
| **unresolved** — no row | nobody has decided; today's default for every existing seller | `#58a` selective enforcement, byte-identical to Today | **refused** (`business_policy_disabled`) — a malformed state §3.4 exists to make unreachable |
| **`legacy_exempt`** — row, `state = 'legacy_exempt'` | an administrator explicitly, with a reason, recorded that this seller stays on the legacy path | `#58a` selective enforcement | `#58a` selective enforcement — dormant proceeds, exhausted refuses — **but the kill switch still applies** (§6) |
| **`governed`** — row, `state = 'governed'` | the seller has entered the booking-credit enforcement regime | `#58a` selective enforcement (the foundation changes no outcome) | **fail-closed**: `not_configured` is a refusal (`entitlement_missing`), exhaustion is a refusal (`entitlement_missing`), only `consumed`/`already_consumed` proceed |
| **ineligible** — `deleted_at IS NOT NULL` | not a seller party any more | not reachable: an order cannot be created for a deleted party | same |

Two of `V33-DEC-036` R2's sentences are made structural by this table: *absence of governance before global activation remains legacy-exempt* (row 1, left column) and *after governance, exhaustion remains governed and fail-closed* (row 3, right column). **Zero credit never means unlimited** in any cell: the only cells where a zero balance proceeds are `#58a`'s dormant path, which requires that the party has **never held a positive grant** — not that its balance is zero.

**Intentional versus unintended exemption is a recorded fact, not an inference.** `V33-DEC-036` R6 and R9 distinguish *intentional* legacy exemption (activation may proceed) from *unintended* exemption (activation must refuse). The only durable, non-inferred representation of intent is a row an administrator wrote with a reason. So "unintentionally legacy-exempt" means precisely **unresolved** — eligible with no row — and nothing else; a `legacy_exempt` row is by definition intentional. The alternative — inferring intent from the age of the seller, from a zero grant, from a subscription state or from ownership — is rejected by R2 ("ownership or capability does not imply any control-plane state") and is exactly how a rollout state becomes an entitlement.

#### 3.3 Explicit transition and explicit exemption — Obligation (`#58b-1`)

Both are privileged administrator commands on the surface in §5, both audited in their own transaction, both idempotent, and both **set-based** (§5.3 explains why no per-seller selector exists).

**Explicit transition to `governed`** requires, for each affected party, inside one transaction and under the locks of §7.2:

1. the party is eligible (§3.1) at the database instant of the write;
2. the party holds **at least one immutable grant with `quantity > 0`** in `commercial.booking_credit_grants` — the authoritative proof that an administrator-published positive entitlement (`V33-DEC-028` Ruling 10) has actually reached this party. A positive `included_booking_credits` on a plan version that the party has *not* activated is not proof: the ledger is the facts (ADR-046 §1). The oldest such grant (`granted_at ASC, id ASC`, the same order ADR-046 §4 allocates in) is recorded as `proof_grant_id`;
3. the row is inserted (`cause = 'explicit_transition'`) or, if a `legacy_exempt` row exists, updated by the one permitted shape;
4. **nothing else is written**: no grant, no subscription, no consumption, no return, no balance. The transition manufactures no allowance (R4) — a party that fails condition 2 is simply not transitioned, and the response counts it as skipped.

**Explicit exemption to `legacy_exempt`** requires, per party, that it is eligible and **unresolved**, and that it holds **no** positive grant — a party already selectively enforced by `#58a` is not a legacy seller in any sense the exemption could honestly describe, and it belongs to the transition command. It inserts a row with `cause = 'explicit_exemption'` and writes nothing else.

**A governed seller remains governed** (R4) when its balance reaches zero, its grant is exhausted, a plan version is retired, a subscription is superseded or cancelled, or the application restarts — because nothing in the platform updates or deletes the row, and the trigger refuses the attempt. This is a database property, and §10 mutates the trigger to prove it is load-bearing.

#### 3.4 The creation race — Obligation (`#58b-2`)

Once `rollout_state = 'active'`, a seller created afterwards must never become unresolved. `V33-DEC-036` R5 rules the mechanism and this ADR fixes its shape, which mirrors the owner-role grant `V33-DEC-021` already installed at the same point:

- `services/provider` and `services/business` each declare a **mandatory** port — `SELLER_GOVERNANCE_INITIALIZATION` / `BUSINESS_GOVERNANCE_INITIALIZATION`, `initializeGovernanceFor(manager, partyId)` — bound in `apps/api` to an adapter over `services/commercial-policy`, injected without `@Optional()` and called without `?.`, immediately after the owner-role grant inside `ProviderService.create` and `BusinessService.create` on the **creating transaction's own manager**;
- the adapter takes the coordination lock in **shared** mode and reads the singleton `FOR SHARE` (§7.2). If `rollout_state = 'inactive'` it writes nothing — a seller created before activation is an ordinary unresolved legacy seller that preview will count and activation will refuse on until an operator classifies it. If `rollout_state = 'active'` it inserts a `governed` row with `cause = 'created_under_enforcement'`, `recorded_by_label = 'system'` and an audit row, and **no grant**;
- if that insert or its audit fails, the creating transaction fails and no seller is created. A seller who exists ungoverned under active enforcement is the defect R5 exists to prevent, so the creation refuses rather than routes around it;
- staff invitation, membership acceptance, role grants and verification transitions call **neither** port — only the two creation paths do (R5: "staff affiliation never triggers governance");
- a user creating a professional and a business gets two rows.

ADR-042 §4 rejected a seller-creation hook **for the base subscription**, and that rejection stands unchanged: its reasons were that a hook cannot reach existing sellers and that two mechanisms drift. Neither applies here. Existing sellers are reached by the explicit, operator-driven commands of §3.3 — reaching them silently is exactly what R4 forbids — and there is exactly one mechanism per epoch: before activation, operators classify; after it, creation classifies. The two never run for the same seller.

### 4. Plane composition — the seam, its inputs and its outcomes

#### 4.1 Where the four-plane decision runs — Obligation (`#58b-1` seam, `#58b-2` outcomes)

The decision runs in `apps/api`, in `BookingCreditEntitlementAdapter.onBookingConfirmation`, **before** `BookingCreditAccountingService.consumeForConfirmation` — the one place that already sees the order's snapshotted party, the confirmation transaction and both domains (ADR-011). `V33-DEC-036` R13: the decision is **upstream of the existing consumption algorithm**, and `consumeForConfirmation` is byte-identical.

| Plane | Source of truth | Read how | Evaluator | Fail-closed when |
|---|---|---|---|---|
| kill switch | `booking_credit_enforcement_control.kill_switch_state` | singleton row `FOR SHARE` on the caller's manager | the adapter | engaged, absent row, malformed row |
| rollout | `booking_credit_enforcement_control.rollout_state` | same row, same lock | the adapter | only meaningful with governance: see §4.3 |
| entitlement | the `#58a` ledger, unchanged | `consumeForConfirmation` under the `bcre` party lock | `BookingCreditAccountingService` | `insufficient_credit`; and, for a governed party under active rollout, `not_configured` |
| business policy / governance | `booking_credit_party_governance.state` for the order's snapshotted party | plain read on the caller's manager, after the party lock | the adapter | unresolved under active rollout; malformed row |

**No plane substitutes for another** (R2), and the composition below is the whole of what "compose" means. `CommercialPolicyControlGate.decide` remains the pure evaluator; `#58b-1` gives it its first production caller by building its `CommercialPolicyControls` from the four reads above.

#### 4.2 Ordering inside the confirmation transaction — Obligation (`#58b-1`)

ADR-046 §5's order is extended by one step and otherwise untouched:

    order row  →  booking row  →  advisory lock (party, bcre)  →  control row FOR SHARE  →  governance read  →  commercial rows

The control row is read **after** the party lock so that a kill-switch engagement (which takes the control row `FOR UPDATE`, §6) and an in-flight confirmation are serialised on that one row — engagement waits for every confirmation that already holds it `FOR SHARE`, and every later confirmation waits for the engagement to commit or roll back. That is the linearizability R8 requires, and it needs no process-local state.

#### 4.3 Outcome table — Obligation (`#58b-1` for the inactive column; `#58b-2` for the active column)

| kill switch | rollout | governance | `#58a` outcome | Decision |
|---|---|---|---|---|
| `engaged` | any | any | not consulted | **refused** — `kill_switch_active` |
| `released` | `inactive` | any | `consumed` / `already_consumed` / `not_configured` | permitted, exactly as Today |
| `released` | `inactive` | any | `insufficient_credit` | refused, exactly as Today |
| `released` | `active` | `governed` | `consumed` / `already_consumed` | permitted |
| `released` | `active` | `governed` | `not_configured` / `insufficient_credit` | **refused** — `entitlement_missing` |
| `released` | `active` | `legacy_exempt` | `consumed` / `already_consumed` / `not_configured` | permitted (the legacy path) |
| `released` | `active` | `legacy_exempt` | `insufficient_credit` | refused |
| `released` | `active` | unresolved / malformed | not consulted | **refused** — `business_policy_disabled` |
| any | any | any | `ineligible` | refused, exactly as Today |

`#58b-1` ships every row whose rollout is `inactive` **unchanged from Today** and the `engaged` row; `#58b-2` ships the `active` rows. Until `#58b-2` merges, `rollout_state` cannot become `active` — no code path writes it — so the foundation cannot change a confirmation outcome except through the kill switch, which is the point of the foundation.

The port type `BookingConfirmationEntitlement` (`services/commerce/src/ports.ts:205`) gains one **additive** member, `{ outcome: 'control_refused'; reason: CommercialPolicyControlRefusal }`, and `ZeroCollectibleConfirmationRefusedException.reason` gains `'control_refused'`. Both are internal vocabularies; §9 fixes what a client sees. This is an additive reason on `#58a`'s seam, not a redesign of its accounting: no table, algorithm, allocation, lock, uniqueness or return rule of ADR-046 changes.

### 5. The operational surface — Obligation (`#58b-1`; activation route `#58b-2`)

#### 5.1 The corrected non-goal

`V33-DEC-036` R7 replaces #95's *"No new HTTP surface, commercial event or `ServiceName`"* with: **no new customer- or seller-facing HTTP surface, commercial event or `ServiceName`; a narrow privileged administrator sub-resource under the existing `v1/admin/commercial` namespace is in scope** for preview, explicit governance transition and exemption, kill-switch engage and release, and — only in `#58b-2` — global activation. Direct SQL, environment variables, startup flags and an unreachable internal method are **rejected** as operator surfaces: none of them is authorized, live-rechecked, reasoned or audited, and an operation that no reachable command can perform is not an operational control.

#### 5.2 Routes, at contract level

One new controller class in `services/commercial-policy`, mounted at `v1/admin/commercial/booking-credit-enforcement`, class-gated exactly as `CommercialCatalogueController` is:

| Method and path | Child | Body | Mutation | Audit action |
|---|---|---|---|---|
| `GET …/booking-credit-enforcement` | `#58b-1` | — | none | none |
| `GET …/booking-credit-enforcement/preview` | `#58b-1` | — | **none** (§5.4) | **none** |
| `POST …/booking-credit-enforcement/transitions` | `#58b-1` | `{ reason }` | set-based explicit transition, §3.3 | `commercial.enforcement_parties_governed` |
| `POST …/booking-credit-enforcement/exemptions` | `#58b-1` | `{ reason }` | set-based explicit exemption, §3.3 | `commercial.enforcement_parties_exempted` |
| `POST …/booking-credit-enforcement/kill-switch/engage` | `#58b-1` | `{ reason }` | §6 | `commercial.enforcement_kill_switch_engaged` |
| `POST …/booking-credit-enforcement/kill-switch/release` | `#58b-1` | `{ reason }` | §6 | `commercial.enforcement_kill_switch_released` |
| `POST …/booking-credit-enforcement/activation` | `#58b-2` | `{ reason }` | §7 | `commercial.enforcement_activated` |

Rules that bind every row:

- capability `bc_manage_commercial_plans`, declared on the **class**, asserted by test over the real route table as the catalogue suite does; it is in `PRIVILEGED_CAPABILITIES`, so live revocation re-check and the boot-time "every mutation declares an audit action" assertion apply automatically. The readiness audit found no reason a narrower capability is necessary today: the administrators who publish plan versions carrying allowances are the administrators who decide when those allowances bind, and a split would introduce a second privileged capability with one holder. Separating the emergency control into its own capability is a **named future decision**, not a rejection;
- every mutation body is exactly `ReasonDto` (3–500 characters, trimmed) and nothing else — `forbidNonWhitelisted` rejects any other field, and there is no field through which a caller could name an owner, user, professional, business, party, subscription, grant or quantity;
- every mutation is `@AuditAction(...)` with the default transactional form, writing `admin.admin_audit_log` on the same manager as the domain change;
- unavailable to customers, sellers and ordinary staff by the capability alone, and additionally by the absence of any `v1/me/*` counterpart — a seller has no route to read their own governance state, exactly as they have none to read their balance (ADR-046 §9);
- the two `GET`s return **no** `actor_user_id`, `recorded_by_user_id`, audit id or party id (§5.4, §8).

#### 5.3 Why the commands are set-based and there is no per-seller selector

`V33-DEC-036` R6 forbids authorizing a per-seller operator reference unless current code proves it necessary. Current code proves the opposite. The owner-bound `workspaceRef` (`deriveWorkspaceReference(secret, ownerUserId, party)`, `libs/workspace-reference`) is an HMAC over the **owner's** user id and cannot be derived, resolved or validated by an administrator; every other reference kind in the repository is owner-bound the same way. A new administrator reference kind would be a fourth reference family created for one story. And the two set predicates in §3.3 **partition** the unresolved set — every unresolved eligible party either holds a positive grant (transition) or does not (exemption) — so the two commands together resolve every seller with no per-seller targeting at all. A per-seller operator reference therefore stays a **named future decision**, to be made if a real remediation case ever needs one seller treated differently from every other seller in the same predicate.

Both commands return only counts: `{ affected, skipped }`.

#### 5.4 Preview — Obligation (`#58b-1`)

`GET …/preview` runs one read-only transaction at `REPEATABLE READ` (a single consistent snapshot; R6) and returns exactly:

```json
{
  "rolloutState": "inactive",
  "killSwitchState": "released",
  "activationGeneration": 0,
  "eligible": 0,
  "governed": 0,
  "legacyExempt": 0,
  "unresolved": 0,
  "wouldBeRefused": 0
}
```

where `eligible` is the §3.1 predicate over both party tables; `governed`, `legacyExempt` and `unresolved` partition it by §3.2; and `wouldBeRefused` is the number of **governed** eligible parties whose derived balance — positive grants minus active consumptions, the ADR-046 §1 arithmetic expressed as one set-based query — is zero, including governed parties that have never held a positive grant. It is the count of sellers who would be refused their next first confirmation if activation happened at this snapshot.

Preview **must**:

- issue a bounded number of statements independent of the number of sellers — one aggregate query per party table for eligibility and governance, one for the balance aggregate — asserted by the query-count test in §10;
- take **no** `FOR UPDATE`/`FOR SHARE`, no advisory lock, write no row and write no audit row — a preview that wrote would inflate the audit trail on every refresh, the objection `V33-DEC-019` already sustained against a `GET` that writes;
- share the §3.1 predicate and the §3.2 partition **by construction** with activation — the same function, not a copy;
- return no id of any kind. Ordinary operational logging and metrics may record that a preview ran and its counts, never a seller.

### 6. Kill switch — Obligation (`#58b-1`)

`V33-DEC-036` R8 makes the switch **platform-wide** for every new commitment that passes through booking-credit enforcement — which, since ADR-046 §3, is **every** first confirmation on both checkout paths, for governed, legacy-exempt and unresolved sellers alike. An emergency control that left the legacy path accepting commitments would not contain the incident it exists for.

| Question | Rule |
|---|---|
| What it blocks | the `onBookingConfirmation` seam returns `control_refused: kill_switch_active` before consulting the ledger; no consumption is written; the zero-collectible path rolls back with nothing collected; the verified-capture path keeps the capture and refunds through the existing idempotent compensation, exactly as `insufficient_credit` does today (ADR-046 §6). **No fallback to unmetered behaviour** |
| What it does not touch | reads, cancellation (customer, professional, system), reschedule, completion, no-show, refund, reversal and credit **return** — `BookingCancellationEntitlementHook` does not consult the switch, so a return is always writable. Already-confirmed bookings stay readable and manageable. No grant, consumption, return, subscription, booking, order or balance is rewritten |
| Engage / release | `POST …/kill-switch/engage` and `…/release`, `bc_manage_commercial_plans`, live-rechecked, mandatory reason, audited in the same transaction. Idempotent: engaging an engaged switch writes no row and no audit and returns the current state |
| Persistence | the singleton row; survives restart because nothing else holds it |
| Concurrency | the command takes the control row `FOR UPDATE` and updates `kill_switch_state`, `kill_switch_changed_at`, `kill_switch_audit_id` in one statement. Every confirmation holds the row `FOR SHARE` (§4.2), so the engagement commits **after** every in-flight confirmation that had already passed the gate and **before** every confirmation that had not — linearizable by PostgreSQL, with no lock held outside either transaction |
| Not a rollback | releasing the switch restores the state the rollout and governance planes describe; it never changes `rollout_state`, `activation_generation` or any governance row |

### 7. Global activation — Obligation (`#58b-2`)

#### 7.1 The command

`POST …/booking-credit-enforcement/activation`, one transaction:

1. take the coordination lock in **exclusive** mode (§7.2) — this waits for every in-flight creation hook and explicit transition/exemption, and blocks new ones;
2. lock the singleton `FOR UPDATE`; if `rollout_state = 'active'` already, write nothing and return the current state (idempotent);
3. evaluate the §3.1/§3.2 partition with the **same function preview uses**; if `unresolved > 0`, refuse — `V33-DEC-036` R9 — writing nothing, not even an audit row, because nothing changed;
4. otherwise update the singleton in one statement: `rollout_state = 'active'`, `activation_generation = activation_generation + 1`, `activated_at = now()`, `activation_audit_id = <the audit row written in this transaction>`; write the audit row with the counts in `after_state`; commit.

It writes no grant and rewrites nothing (R9). It cannot be reversed by any route: the trigger of §2.1 refuses `active → inactive`, and no administrator command exists for it. Emergency containment is §6; permanent deactivation is a new owner decision, and `activation_generation` exists so that such a decision, if ever taken, can version its consequences visibly.

#### 7.2 Locking — the scheme and its order — Obligation (`#58b-1` for the locks it uses; `#58b-2` for activation)

`V33-DEC-036` R10 chooses PostgreSQL-authoritative locking: no process-local mutex, no Redis, no check-then-act across transactions, no lock outside the caller's transaction.

**The coordination lock.** A new transaction-scoped advisory-lock namespace, `BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE = 0x62_63_67_76 | 0` (`bcgv`), distinct from `aicn`, `bkas`, `srrq`, `bcre` and `wish` and asserted distinct by the existing namespace-uniqueness test, with a single fixed key (`0`):

- `pg_advisory_xact_lock(bcgv, 0)` — **exclusive** — activation only;
- `pg_advisory_xact_lock_shared(bcgv, 0)` — **shared** — the creation hook (§3.4), explicit transition and explicit exemption (§3.3).

Shared holders never block one another, so seller creation and operator transitions proceed concurrently in the ordinary case; activation waits for all of them and excludes them for the duration of its own transaction, which is what makes "no unresolved seller" true at the commit instant and not merely at the read instant.

**The fixed order**, per operation:

| Operation | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| confirmation (Today + §4.2) | order row | booking row | `bcre` party lock | control row `FOR SHARE` → governance read → commercial rows |
| kill-switch engage/release | control row `FOR UPDATE` | — | — | — |
| creation hook | `bcgv` shared | control row `FOR SHARE` | governance insert | — |
| explicit transition / exemption | `bcgv` shared | `bcre` party lock, **per party in `(party_type, party_id)` ascending** | control row `FOR SHARE` | governance write |
| activation | `bcgv` exclusive | control row `FOR UPDATE` | partition read (no row locks) | control row update |
| preview | none | none | none | none |

**Deadlock analysis.** Every operation acquires locks in the same global order — `bcgv` → order/booking rows → `bcre` → control row → domain rows — and no operation ever acquires an earlier class after a later one. Confirmation never takes `bcgv`; activation and the kill switch never take `bcre`, an order row or a booking row; so the only shared edge between the confirmation path and the control commands is the control row, on which confirmations hold `FOR SHARE` and the commands wait `FOR UPDATE` — a wait, never a cycle. Transition and confirmation on the same party both take `bcre` first and then the control row in a compatible mode, so they serialise on `bcre`. Batch transition locks parties in one deterministic order, so two concurrent batches cannot cross. Activation holds `bcgv` exclusively before it touches the control row, and every writer of governance rows holds `bcgv` shared before its own writes, so activation's partition read is over a set that nobody can be mid-way through changing.

### 8. Privacy and audit — Obligation (`#58b-1`)

| Table | ADR-027 disposition | Detector | Pinning |
|---|---|---|---|
| `commercial.booking_credit_enforcement_control` | `no_subject_data` — a platform state with two opaque audit-row ids and no actor column | cannot fire (no `_by`/`_user_id` column), so the claim rests on the reason and on a test | an explicit test asserts the disposition and that the column set contains no subject column, exactly as `#131`'s `retained` claim is pinned |
| `commercial.booking_credit_party_governance` | `retained` — an operational and legal obligation record naming a seller party and the administrator who acted, claimed by the subscription subject-data contract alongside the ledger tables it belongs with | `recorded_by_user_id` makes `wrongly_declared_empty` fire on a dishonest `no_subject_data` claim | an explicit test asserts `retained` |

**Export.** A subject who owns a party receives, in the subscription contract's export, that party's governance state, cause, `recorded_at` and `governed_at` — the facts about *their* seller workspace — and **never** `recorded_by_user_id`, `recorded_by_label`, `audit_id` or `proof_grant_id`. A customer's export contains nothing from either table: no customer identity appears in them, and rollout state is not a fact about a customer. Administrator identity stays in `admin.admin_audit_log`, behind `v1/admin/audit-log`.

**Erasure** preserves both tables in full. Deleting a governance row would silently return a seller to legacy exemption — the one thing R3 and R12 forbid — and the party id it names points, after the owning module's own erasure, at an anonymized row (ADR-042 §11's reasoning, unchanged). The singleton holds no subject.

**Audit.** Every mutation in §5.2 and §7 writes one `admin.admin_audit_log` row in its own transaction, `actor_user_id` from the session, `target_type = 'commercial.booking_credit_enforcement'`, `target_id` the singleton or the governance row, `before_state`/`after_state` the changed columns (counts for the set-based commands), `reason` the administrator's typed prose. The creation hook audits with `actor_label = 'system'`. The closed action vocabulary is the seven `commercial.enforcement_*` actions in §5.2, added to the existing constants file. Preview and the control `GET` write **no** audit row.

### 9. Failure contract — Obligation (`#58b-1`)

Every control-plane refusal reaching a customer collapses to the **existing** public refusal, `BOOKING_NOT_CONFIRMABLE` (HTTP 409, the same one Persian sentence), exactly as `insufficient_credit` already does: a customer must not be able to tell a kill switch from an exhausted balance from an unresolved seller, and none of those is a fact about the customer. Internally the reason stays distinct — `kill_switch_active`, `rollout_disabled`, `entitlement_missing`, `business_policy_disabled` — for logs and metrics that carry no seller identity.

On the administrator surface: an unknown or malformed body is the framework's `400`; a missing or revoked capability is the existing privileged refusal; a refused activation (§7.1 step 3) is a `409` carrying only the same counts preview returns, so the operator learns *how many* are unresolved and never *who*; an engaged switch, an already-active rollout and an already-governed party are idempotent successes, not errors. A missing or malformed singleton row is a **500-class server fault** on the administrator surface — an operator must see it loudly — and a refusal on the confirmation path.

### 10. Verification and mutation matrix — Obligation (`#58b-1` unless marked `#58b-2`)

Real PostgreSQL is required wherever a row lock, advisory lock, trigger, exclusion, `REPEATABLE READ` snapshot or genuine concurrency is the property under test; pg-mem honours none of them. "Kill" means the named test fails for the named reason; a compile error is not a kill.

| # | Test | Real PG | Mutation probe that must kill it |
|---|---|---|---|
| 1 | preview writes nothing: row counts of both tables and of `admin.admin_audit_log` are byte-identical before and after, and `pg_stat_activity` shows no lock held | yes | make preview write an audit row |
| 2 | preview and activation share one predicate: mutate the shared function once and both change; a structural test asserts exactly one definition site | yes | duplicate the predicate for activation and drift the copy |
| 3 | activation refuses with **one** unresolved eligible seller, writes nothing, returns the counts (`#58b-2`) | yes | make activation proceed when `unresolved = 1` |
| 4 | activation succeeds when every eligible seller is resolved, increments the generation once, is idempotent on replay (`#58b-2`) | yes | skip the generation increment; allow a second activation to write a second audit row |
| 5 | activation races seller creation under `Promise.allSettled`: either the seller exists governed or the activation refused, never an unresolved seller under active rollout (`#58b-2`) | yes | take the coordination lock in shared mode in activation |
| 6 | activation races an explicit transition: the transition either commits before activation reads or after activation commits, never between | yes | drop the `bcgv` shared lock from the transition |
| 7 | control and governance state survive `app.close()` and a fresh `createPgTestApp()` against the same database | yes | cache any plane in process memory |
| 8 | a governed seller with zero remaining credit is refused a new first confirmation under active rollout (`#58b-2`) | yes | treat `insufficient_credit` as permitted for governed parties |
| 9 | a governed seller that never held a positive grant is refused under active rollout (`#58b-2`) | yes | treat `not_configured` as permitted for governed parties |
| 10 | a `legacy_exempt` seller and an unresolved seller under **inactive** rollout confirm byte-identically to a pre-foundation baseline | yes | consult governance while rollout is inactive |
| 11 | transition skips a party with no positive grant and governs one with a positive grant; the skipped party has no row afterwards | yes | drop condition 2 of §3.3 |
| 12 | transition writes no grant: the grant table's row count and every row are byte-identical | yes | insert a grant in the transition |
| 13 | transition is idempotent and two concurrent batch transitions produce one row per party with one audit each | yes | drop the per-party `bcre` lock or the deterministic ordering |
| 14 | an engaged switch refuses a new first confirmation on **both** checkout paths, for a governed, a `legacy_exempt` and an unresolved seller; the paid path refunds the verified amount | yes | exempt `legacy_exempt` sellers from the switch |
| 15 | engaging the switch rewrites nothing: every grant, consumption, return, subscription, booking and order row is byte-identical | yes | any write beyond the singleton and its audit |
| 16 | with the switch engaged, cancellation by `professional` and by `system` still writes the credit return; reschedule and completion still succeed | yes | consult the switch in the cancellation hook |
| 17 | a token issued before `bc_manage_commercial_plans` is revoked is refused on every mutation and both reads | yes | drop the class-level capability |
| 18 | a `business_staff` member of a governed business, holding every non-privileged capability, can reach no route here and triggers no governance row on acceptance | yes | call the initialization port from staff acceptance |
| 19 | a user owning a professional and a business has two governance rows, transitioned independently | yes | key governance by owner instead of party |
| 20 | an injected failure after the control update and before the audit insert rolls back both | yes | write the audit with `transactional: false` |
| 21 | the customer sees `BOOKING_NOT_CONFIRMABLE` with an identical body for kill switch, exhaustion and unresolved-under-active-rollout | yes | surface the internal reason |
| 22 | preview issues the same number of statements for 1 and for 50 eligible sellers | yes | a per-seller balance query |
| 23 | every `#58a` real-PostgreSQL test passes unchanged; `booking_credit_grants`, `_consumptions`, `_returns` constraint definitions are byte-identical; `consumeForConfirmation`'s source is unchanged | yes | any edit to `booking-credit-accounting.service.ts` |
| 24 | the existing no-hardcoded-allowance guard and a structural scan of the new migration find no numeric commercial value, no env read and no default that confers entitlement | no | add `DEFAULT 200` anywhere |
| 25 | `DELETE` on either table, `active → inactive`, a generation decrement and `governed → legacy_exempt` are refused by trigger | yes | drop the trigger |
| 26 | `ck_bcec_singleton` refuses `id = 2`; `uq_bcpg_party` refuses a second row per party; `ck_bcpg_cause_state` and `ck_bcpg_proof` refuse every illegal combination | yes | drop each constraint |
| 27 | both dispositions are pinned; a `no_subject_data` claim on the governance table produces `wrongly_declared_empty`; export contains no `recorded_by_user_id`, `audit_id` or `proof_grant_id` | yes | change either disposition; add the actor column to the export |
| 28 | the creation hook under active rollout writes a governed row with `cause = 'created_under_enforcement'` and no grant; under inactive rollout writes nothing; a failing hook leaves no seller row (`#58b-2`) | yes | make the port `@Optional()` |
| 29 | `bcgv` is distinct from every other namespace (the existing uniqueness test extended) | no | reuse `bcre` |
| 30 | the control-plane refusal member is additive: `BookingConfirmationEntitlement`'s existing members are byte-identical | no | rename `not_configured` |

### 11. Implementation order

`#58b-1`, in this order, each step green before the next: migration and entities with tests 24–27 → the four-plane seam in the adapter reading `inactive` rollout with tests 10, 14–16, 21, 23 → the administrator controller with tests 1, 2, 11–13, 17–20, 22 → restart test 7. Then `#58b-2`, after its own fresh preflight: the creation hook (28) → activation (3–6, 8, 9). No `#58b-2` code may merge before `#58b-1` has.

---

## Considered and rejected

| Alternative | Rejected because |
|---|---|
| Business-policy plane as a constant `true` (the readiness audit's own suggestion) | `V33-DEC-036` R2: a constant makes the fourth control fictional and cannot distinguish an explicitly governed seller from a legacy-exempt one |
| Infer governance from "holds any positive grant" | a grant is entitlement, not governance (R2); it cannot represent an intentional exemption; and it silently governs every seller an administrator ever grants to, which is the backfill R4 forbids |
| Infer governance from an active subscription with a positive snapshotted allowance | survives neither cancellation nor supersession, so a governed seller could become ungoverned by cancelling — the opposite of monotonic |
| Four boolean columns on one table | collapse distinct lifecycle facts (activation generation, intent, cause, actor) and permit invalid combinations the CHECKs in §2 exist to forbid |
| A separate immutable governance-history table | duplicates `admin.admin_audit_log`'s `before_state`/`after_state` for one state transition (R3.C) |
| Actor columns on the singleton | duplicate the audit log for no reader that needs them, and make a two-value platform state carry subject data (R12) |
| No actor columns on the governance row | the domain that reads governance may not read `admin.*`, and the owner named the row as the carrier of actor facts (R12) |
| An operator CLI, a migration, an env var or startup flag | none is authorized, live-rechecked, reasoned or audited; R7 rejects each by name |
| A per-seller opaque administrator reference | R6 forbids it without proof of necessity; the set-based commands resolve every seller without one (§5.3) |
| Kill switch scoped to governed sellers only | R8: leaves the legacy path accepting commitments during the incident |
| An ordinary deactivation route | R9: reversal is not an ordinary transition; the generation column and the trigger make it an owner decision rather than a click |
| A process mutex, Redis lock or check-then-act across transactions | R10; and every one of them is exactly the class of lock the `#128` post-merge probe found untestable |
| Reusing `bcre` as the coordination namespace | `bcre` is keyed per party; a global key in it would serialise activation against every confirmation on the platform |
| Gating confirmation on `verification_status` | invents behaviour no confirmation path has today (Context) |

## Consequences

- **Positive.** Every control-plane fact is a PostgreSQL row with a named constraint, and every operator action is a reachable, gated, reasoned, audited command. The four planes `V33-DEC-007` named in 2026-09-01 acquire persistence and a production caller without touching the ledger they gate.
- **Positive.** An operator can run the foundation for as long as they need, watching the preview, transitioning cohorts and rehearsing the kill switch, with no seller's outcome changed until a separate story flips one row under an exclusive lock.
- **Negative, disclosed.** Every first confirmation now takes one more shared row lock and one more read. The lock is shared, so confirmations do not contend with one another; they wait only behind a kill-switch mutation, which is the intended behaviour.
- **Negative, disclosed.** Activation refuses until every seller is classified. On a platform with many dormant legacy sellers that is real operator work — two set-based commands — and it is the point: the alternative is a silent decision about them.
- **Negative, disclosed.** A seller created during activation's exclusive window waits for it. Activation is one transaction over aggregate queries; the window is short.

## Rollout and non-activation boundary

Merging `#58b-1` changes no confirmation outcome: `rollout_state` is `inactive`, no code path writes `active`, and the only reachable change of behaviour is a kill switch an administrator engages on purpose. Merging `#58b-2` still changes nothing until an administrator with `bc_manage_commercial_plans` runs the activation command after preview reports zero unresolved sellers. No plan price, included allowance, grace, expiry, overage, cutoff, retention rule, notification threshold, provider, payment, deposit, commission, settlement, tag, Release or deployment is activated or approved by this ADR or by either child.

## Non-goals

No change to `#58a`'s tables, triggers, allocation order, per-party lock, one-consumption-per-booking rule, no-negative-balance rule or return model (R13). No positive allowance, price, grace, expiry, cutoff, retention or notification value. No customer- or seller-facing route, event or `ServiceName`. No balance dashboard. No per-seller administrator reference. No ordinary deactivation. No verification-status gate on confirmation. No maker-checker. No `business_staff` involvement of any kind. No custom-purchase, gateway, payout or settlement work — #99, #43, #47 and #42 keep every gate they have.

## Open gates

- Permanent deactivation of global enforcement — a new owner decision; `activation_generation` exists for it.
- A narrower capability for the emergency control — named future decision (§5.2).
- A per-seller administrator reference for remediation — named future decision (§5.3).
- Whether verification status should ever gate confirmation — outside #95; would compose above this seam.
- Every commercial value in `V33-DEC-028`'s `OPEN / UNPUBLISHED` list, unchanged.
