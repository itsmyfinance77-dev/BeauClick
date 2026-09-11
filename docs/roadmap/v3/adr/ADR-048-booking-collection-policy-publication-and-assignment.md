# ADR-048 — Collection policy is an administrator-published version; an order snapshots the one that priced it

**Status:** ACCEPTED — 2026-09-06
**Approver:** product owner (`V33-DEC-028` and `V33-DEC-029` ratified 2026-09-06)
**Backlog:** #83 (`#41d-1`)
**Depends on:** ADR-039 (the control plane and its browser-safe contract), ADR-041
(the versioned-catalogue pattern this schema follows), ADR-043 (the immutable
per-order schedule this writes into), ADR-044 (zero-collectible confirmation),
ADR-045 (deposit capture and collected accounting), ADR-027 (subject-data
contract), ADR-023 (business is its own seller party), ADR-018 (same-cluster
consistency), ADR-011 (module boundaries)
**Constrains:** #83 (`#41d-1`), #104 (`#41d-2a`), #115 (`#41d-2b`)
*(`#41d-2` was split 2026-09-07 by `V33-DEC-031` into #104 `#41d-2a`, seller
assignment, and #115 `#41d-2b`, order resolution and the immutable snapshot. Every
technical rule below is unchanged and now binds whichever child owns it: R1 and R3–R5's
order-path rules bind #115, and R2's assignment rules bind #104.)*

**Amended 2026-09-11 (`V33-DEC-036`) — scope clarification, no rule changed.**
`V33-DEC-028`'s "Next ADR" section, and ADR-039's 2026-09-06 note, assigned "the
persistence and composition of the four control planes in Ruling 11" to this ADR. This ADR
never took that assignment: it specifies collection-policy publication, seller assignment and
the order snapshot, and contains no control-state table, no rollout or kill-switch
persistence, no per-seller governance fact and no plane composition — #95 appears below only
as a non-goal. That obligation is now recorded in
[ADR-050](ADR-050-booking-credit-enforcement-control-plane.md), which reuses two of this ADR's
own patterns — presence-as-fact (R2) and `FOR SHARE` linearization (R5) — and which does not
touch collection policy. Every rule of this ADR, and the `#58a` accounting model it leaves
alone, is unchanged.

**Amended 2026-09-07 (Story #104 readiness audit) — order resolution.** The
`#41d-2` readiness recheck against the shipped `#41d-1` code found two
load-bearing engineering defects and one internal inconsistency in this ADR, all
of which had to be settled before order-integration code could be written. Five
rules are bound in place below and are marked **R1**–**R5** where they appear:

- **R1 — the schedule's `collection_mode` is derived from the computed amounts,
  never copied from the policy terms.** `bookingCollectionAmountsV1` legitimately
  returns a collectible of `0` (a percentage flooring to zero) or of exactly
  `serviceTotalToman` (a fixed amount or minimum clamped to the total), while
  `commerce.order_payment_schedules`'s shipped `ck_ops_mode_consistent` admits
  `deposit_online_balance_at_venue` only when `0 < collectible < total`
  **strictly**. Without R1 a policy an administrator is entitled to publish would
  refuse a booking for particular order amounts. See §2.
- **R2 — assignment presence *is* enrollment.** There is no separate enrollment
  marker and no runtime un-enrollment. See §3 and §6.
- **R3 — one transaction and connection, one seller-party selection.** See §1
  and §4.
- **R4 — the runtime resolver is separate from the administrator writer.** See
  §1.
- **R5 — `FOR SHARE` and compare-and-swap linearization.** See §4.

This is an **engineering consistency correction** inside the already-ratified
`V33-DEC-028` and `V33-DEC-029` structure. It chooses no price, percentage,
amount, bound, enabled mode, rollout percentage, legal wording or external
provider behaviour, and it creates no new ADR id. The original text of every
corrected passage is preserved and marked rather than rewritten.

**Amended 2026-09-06 (Story #83 implementation audit) — the exclusion interval.**
§3 as accepted specified a plain `tstzrange(activation_starts_at,
activation_ends_at, '[)')` partial on `lifecycle_state <> 'draft'`, while §4
required that retirement never rewrite the activation window and permitted an
open-ended published version. Those three are jointly unsatisfiable: a version
published open-ended and then retired keeps `activation_ends_at IS NULL`, so its
indexed interval stays `[start, infinity)` for ever and **every later version of
the same key overlaps it permanently** — forward republication, which §4
explicitly requires, becomes impossible after the first retirement. This is an
engineering consistency correction, not a new commercial decision: it approves
no value and changes no ruling of `V33-DEC-028` or `V33-DEC-029`. The original
§3 sentence is preserved below with the corrected invariant stated beside it.

## Context

`V33-DEC-028` closed the commercial structure: every commercial parameter is an
administrator-managed immutable version, no commercial number survives as a code
constant, every commitment snapshots what became binding, and missing
configuration fails closed. `V33-DEC-029` then decomposed Story #83 after a
readiness audit found that the story, as written, could not have been built
honestly.

Four repository facts drive every decision below. Each was verified against
`77ec5ee240db926743ef1d7eafd55761049b6c4f` and re-checked after `284a0fc`.

**The only terms type available demands values this story does not own.**
`BookingCommercialTermsV1` (`packages/commercial-policy-contract/src/commercial-policy-contract.ts:40-53`)
requires `cancellationCutoffMinutesBeforeStart`,
`lateCancellationRetainBasisPointsOfDeposit`,
`noShowRetainBasisPointsOfDeposit`, `rescheduleDepositAction` and
`disputeWindowMinutes` — all #42 — and `settlementDelayMinutes` — #43. None is
optional, and `validateBookingCommercialTermsV1` rejects a terms object without
them. It also requires a non-empty `customerPolicyCopyVersion`, and no approved
Persian copy, version identifier or acceptance record exists anywhere in the
repository.

**The percentage rule has no base.** `PercentageDepositTerms` (`:23-28`) carries
a rate and bounds; `collectionBreakdownV1` (`:186-217`) applies the rate to
whatever `serviceTotalToman` its caller passes. Nothing records which amount the
administrator meant.

**The order schedule refuses a policy reference without acceptance.**
`ck_ops_policy_reference`
(`database/migrations/commerce/20260905900001_create_order_payment_schedules.sql:107-110`)
is all three or none: key, version **and** `policy_accepted_at`.

**One writer serves every order.** `order.service.ts:315-325` inserts
`full_payment_online` with the whole total collectible and a null policy triple,
unconditionally. Everything downstream is already schedule-driven —
`checkout.service.ts:239` branches on `schedule.platformCollectibleToman` and
`:257-260` asks the gateway for it — so that single writer is the only thing
deciding the mode today, and a fail-closed path there would stop every booking
on the platform.

What already exists and is reused rather than rebuilt: the versioned-catalogue
lifecycle, its GiST exclusion constraints and its paired actor CHECKs
(`database/migrations/commercial/20260902800001_create_commercial_catalogue.sql`);
the privileged, class-gated, transactionally-audited admin controller
(`services/commercial-policy/src/catalogue/commercial-catalogue.controller.ts:62`);
the ownership-only party resolver
(`services/commercial-policy/src/subscription/owned-subscriber-party.port.ts`);
the opaque `workspaceRef`
(`services/commercial-policy/src/seller-surface/workspace-reference.ts`); and the
single-refusal precedent
(`services/commercial-policy/src/seller-surface/credit-purchase.exceptions.ts`).

## Decision

### 1. Domain ownership and ports

`commercial` owns the policy key aggregate, its versions and the seller-party
assignment. `commerce` owns the immutable per-order schedule and the snapshot
written into it. Neither reaches into the other's tables.

*(**R3/R4, added 2026-09-07.** Two things this paragraph assumed are not true of
the shipped code, and both are corrected here.*

*First, **`ServiceCatalog.findServiceOffering` and `SellerPartyLookup.forProfessional`
must be made manager-scoped**. Today neither accepts an `EntityManager`
(`services/commerce/src/ports.ts:36`), and `ProviderBackedServiceCatalog` and
`SellerPartyLookup` both read through injected repositories
(`apps/api/src/composition/port-adapters.ts:71-92`, `:54-68`) — that is, on a
**different pooled connection** from the transaction
`OrderService.createForBookingWithin` is running in. Under `#41d-1` that is
merely a possibly-stale read and two extra pooled connections held open per order
creation. Under `#41d-2` it becomes a split-brain: the seller party would be read
on one connection while its assignment and policy version are read on the
transaction's, and one immutable order snapshot would be assembled from two.
Both must take the caller's `EntityManager` and query through it, exactly as
`OwnedSubscriberPartyResolver` already does for the same reason.*

***Be precise about what that guarantees.*** *PostgreSQL's default `READ
COMMITTED` isolation gives every statement its own fresh snapshot, so sharing one
`EntityManager` does **not** mean every statement observes one immutable
transaction snapshot, and this ADR does **not** authorize changing the isolation
level. The guarantee R3 actually establishes is narrower and sufficient:*

- *one transaction on one connection, with no out-of-transaction read;*
- *the seller party is selected **once**, at the offering-read statement;*
- *that exact value is written to the order and passed unchanged to policy
  resolution — it is **never re-resolved** later in the same order path;*
- *a later affiliation change therefore cannot reinterpret an order that has
  already been written.*

*Second, **the runtime resolver is a separate service from the administrator
writer**. A resolution method must not be added to `BookingCollectionPolicyService`:
that class's entire contract is that every method takes an `actorUserId` and
writes an audit row in the same transaction, whereas resolution is an unaudited,
actor-free read on a caller's transaction. Merging them would combine two
distinct authorization and audit surfaces and put the audited administrator
writer on the order hot path. The resolver receives the already-selected seller
party and never a client-supplied identity; it returns exactly
`legacy_unenrolled` or a validated `BookingCollectionPolicySnapshotV1`, with a
closed identity-free internal cause on an enrolled failure and **no fallback,
cache, "latest", environment key, default or fabricated policy**.)*

Commerce consumes a **narrow, manager-scoped resolver port** declared in
`services/commerce/src/ports.ts` beside `ServiceCatalog`, bound at the API
composition root exactly as `ProviderBackedServiceCatalog` is. The port takes the
caller's `EntityManager`, so resolution happens inside the order transaction,
sees its uncommitted rows and rolls back with it.

**No cross-domain entity, repository or ORM import.** Commerce must not import a
`commercial` entity, and `@nx/enforce-module-boundaries` is the mechanism, not a
convention.

**The database-backed resolver is the only production source.** The in-memory
`CommercialPolicyRegistry` survives **only** for deterministic contract and
sandbox tests, behind the same port. Production has no cache, no default, and no
"latest" lookup — asking for "latest" is how a historical order silently adopts
live configuration, which ADR-039 already forbids.

### 2. Contract decomposition

`#41d-1` introduces a **collection-only** terms and snapshot contract in
`packages/commercial-policy-contract`, carrying exactly:

- the collection mode;
- the deposit calculation rule (`none | fixed | percentage`) and its amounts;
- the percentage calculation base;
- the contract version;
- the policy key and version;
- the **resolution instant**.

`BookingCommercialTermsV1` is **not** widened, **not** deleted, and **not**
filled in. It remains the eventual whole-policy type; #42 and #43 add their own
outcome and settlement contracts, and the composition of the three is a later
decision. **No field is populated with a zero, an empty string, a placeholder, a
default or an invented version identifier** — a zero cutoff and a zero retention
are *values*, and a fabricated copy version is *legal metadata*.

**`resolvedAt` is not renamed acceptance.** The resolution instant records when
the server selected a version. `policy_accepted_at` records that a customer
accepted approved terms. They are different facts with different owners, and the
contract must never let one stand in for the other.

**Percentage base.** An enum of exactly `service_subtotal | service_total`,
**required** when the rule is `percentage` and **absent** otherwise, with **no
default**. Both amounts exist authoritatively at order creation
(`order.service.ts:253,256`), and `pricing.types.ts:45-52` already records the
platform's no-compounding rule that `subtotalToman` is the immutable base every
percentage rule uses — so the vocabulary is closed without either value being
chosen. **Neither `#41d-1` nor `#41d-2` chooses one.**

**Arithmetic is unchanged and binding.** BigInt floor division, then the minimum
clamp, then the maximum clamp, then the final clamp to the service total — the
order `collectionBreakdownV1` already implements. Integer Toman throughout; never
a float, never a decimal string.

**R1 — the schedule records the computed outcome, not the policy's mode.**
*(Added 2026-09-07. The paragraph above is correct about the amounts and silent
about the mode, and that silence is what the Story #104 audit found.)*

A published policy version records the **administrator's rule**. The immutable
order schedule records the **result of applying that rule to one order's
amounts**. They are not the same fact, and `#41d-2` must not copy
`terms.collectionMode` onto the schedule. After `bookingCollectionAmountsV1` has
computed the exact amounts, the recorded mode is derived from them:

| Computed amounts | `commerce.order_payment_schedules.collection_mode` |
|---|---|
| `platformCollectibleToman === 0` | `pay_at_venue` |
| `platformCollectibleToman === serviceTotalToman` | `full_payment_online` |
| `0 < platformCollectibleToman < serviceTotalToman` | `deposit_online_balance_at_venue` |

**Why this is required rather than tidy.** The shipped
`ck_ops_mode_consistent` admits `deposit_online_balance_at_venue` only when
`platform_collectible_toman > 0 AND platform_collectible_toman < service_total_toman`
— **strictly**
(`database/migrations/commerce/20260905900001_create_order_payment_schedules.sql:96-104`).
The shipped helper legitimately produces both excluded values for terms that pass
`validateBookingCollectionTermsV1` **and** every
`commercial.booking_collection_policy_versions` CHECK:

- a **percentage flooring to zero** — `ck_bcpv_deposit_rate` permits
  `deposit_basis_points >= 1`, and one basis point of a 9,999 total floors to `0`
  (asserted at
  `packages/commercial-policy-contract/src/booking-collection-policy-contract.spec.ts:220-223`);
- a **fixed amount or minimum reaching the total** — `ck_bcpv_deposit_amount`
  permits any `deposit_amount_toman > 0`, and the final clamp returns exactly the
  service total (asserted at `…spec.ts:247`);
- a **zero-priced service**, where every amount is zero.

Publication validation cannot prevent this, and that is the point: whether a
policy would violate the CHECK depends on the **order's** amounts, not on the
policy. The same published policy is writable for one booking and not for the
next. The contract is not wrong either — it computes the correct amount; only the
recorded mode was undefined.

Deriving it is also what the database already says these modes mean:
*"A deposit equal to the total is `full_payment_online` and a deposit of zero is
`pay_at_venue`; permitting either spelling here would make 'which mode was this?'
ambiguous at the row level"* (same file, `:90-94`). It is `V33-DEC-028` Ruling 6
restated at the row: **the row records the outcome, the referenced policy version
records the rule.** No policy history is lost, because the snapshotted
`policy_key` and `policy_version` still identify exactly which rule produced the
amounts.

The rejected alternative is to refuse the booking. That would turn a
one-basis-point rounding artefact into a customer-visible failure with no
operator signal, and it would make an administrator's valid publication
unusable at amounts nobody predicted.

**This is not a commercial-value decision.** It selects no rate, amount, bound or
enabled mode; it decides only which of three already-ratified vocabulary members
truthfully describes an outcome the arithmetic has already produced.

### 3. Schema blueprint

No SQL appears in this ADR. The shape does.

**`commercial.booking_collection_policies`** — the stable-key aggregate. Key,
display name, purpose, creation actor and time. The key is immutable; a rewrite
is refused by trigger, as `tg_plans_immutable` already refuses one.

**`commercial.booking_collection_policy_versions`** — the immutable version.
Key + version unique; `lifecycle_state` defaulting to `draft` with the INSERT
branch refusing any other, so a row cannot be born published; collection mode;
deposit kind and its amounts and rate; percentage base; contract version;
`activation_starts_at` / `activation_ends_at`; and the three paired
created / published / retired actor-and-time triples.

CHECKs required on it:

- lifecycle membership, and the actor/time pairing for each lifecycle state;
- **deposit shape** — a deposit exists if and only if the mode is
  `deposit_online_balance_at_venue`, mirroring the contract's rule in SQL rather
  than trusting the service;
- amount and rate bounds — non-negative integer Toman, basis points in
  `1..10000`, maximum not below minimum;
- **percentage-base conditionality** — non-null exactly when the kind is
  `percentage`;
- **non-retroactivity** — `activation_starts_at >= published_at` on any non-draft
  row;
- window ordering — `activation_ends_at > activation_starts_at` or null.

Constraints and triggers required on it:

- a **GiST exclusion constraint** on `(policy_key WITH =, tstzrange(start, end,
  '[)') WITH &&)` partial on `lifecycle_state <> 'draft'` — the same shape as
  `ex_price_schedule_versions_no_overlap`, and for the same reason: under READ
  COMMITTED two concurrent publications each observe a free timeline and both
  commit;

  *(**Corrected 2026-09-06.** The sentence above states the mechanism correctly
  and the interval incorrectly. The indexed value is not the configured window
  but the version's **effective** window, computed by an `IMMUTABLE` PostgreSQL
  expression as:*

  - *the interval starts at `activation_starts_at`;*
  - *it ends at the **earlier** of the configured `activation_ends_at` — absent
    meaning `infinity` — and, **when and only when the row is retired**,
    `retired_at`;*
  - *the upper bound is floored at the lower bound, so a version retired before
    it ever activated yields an **empty** interval, which overlaps nothing and
    raises no range error;*
  - *the range stays half-open `[)`, so a replacement may start at the exact
    database instant its predecessor retired.*

  *Consequences, all of them required by §4 and none of them weakened: an
  open-ended published version becomes a **finite historical interval** the
  moment it is retired; **retirement writes only lifecycle and retirement
  facts** and never touches `activation_starts_at` or `activation_ends_at`;
  historical effective intervals still cannot overlap, because the retired
  version's interval is closed at its own retirement rather than dropped from
  the index; and forward republication works for ever.*

  *The constraint is deliberately **not** narrowed to published rows only.
  Excluding retired rows from the index would also make historical overlap
  representable — two versions could be recorded as simultaneously effective in
  the past — and the whole purpose of the constraint is that the effective
  timeline of a key is a function of the database's own history rather than of
  which rows happen to be live. A raw-SQL and concurrency suite proves the
  open-ended publish → retire → replacement-publish sequence, adjacency at the
  exact retirement instant, and the impossibility of historical overlap.)*
- an immutability trigger refusing edits to a published or retired row, and
  refusing revival of a retired one.

**`commercial.seller_collection_policy_assignments`** — seller-party scope only.
`(seller_party_type, seller_party_id)`, the assigned **policy key**, an
enrollment marker, actor and time facts, and **one current assignment per party**
enforced by a partial unique index. History is kept by explicit supersession — a
superseded row is never deleted or rewritten.

*(**R2, corrected 2026-09-07.** The phrase "an enrollment marker" above is
superseded and is preserved only as the original wording. **There is no separate
enrollment marker, boolean or state column.** The presence of one current
assignment row **is** the enrollment fact:*

- *no current row → the party is **unenrolled** and keeps the legacy path;*
- *one current row → the party is **enrolled**; order creation must resolve that
  key or **fail closed**;*
- *superseded rows are immutable history;*
- *replacing an assignment is **supersession**, never an in-place mutation of
  `policy_key` on the current row.*

*A separate marker would immediately admit the incoherent state "enrolled with no
assignment", which `V33-DEC-029` Ruling 8 gives no behaviour for. Presence is
also the only thing that distinguishes an **enrolled party whose key currently
has no resolvable active published version** — which must fail closed — from a
party that was never enrolled, which must not.*

***No runtime un-enrollment, clear or delete path is authorized by `#41d-2`.***
*Returning an enrolled party to the legacy full-online path by removing its row
is the post-lookup fallback `V33-DEC-029` Ruling 8 forbids, wearing a different
name. If un-enrollment is ever wanted it is its own story and its own decision.)* **No foreign key to an external
domain's identity table**, in keeping with the repository's cross-schema
convention, so a provider or business row's lifecycle cannot cascade away
commercial history.

**ADR-027 disposition is declared for each new table**, added to
`commercial-subject-data.contract.ts` and proved by the existing exact-set
assertion (`apps/api/test/privacy.pg-spec.ts:165`). No user-id-shaped column is
invented merely to trigger a heuristic; the assignment's subject relationship is
the seller party, and the disposition states that plainly.

**`commerce.order_payment_schedules` changes once, in `#41d-2`.**
`ck_ops_policy_reference` is replaced by: `policy_key` and `policy_version`
all-or-none; `policy_version >= 1` when present (already
`ck_ops_policy_version_positive`); and **`policy_accepted_at` independently
nullable**. Existing rows — every one of which carries an all-null triple —
remain valid and byte-identical. No column is added, and the row stays immutable
under `tg_order_payment_schedules_immutable`.

### 4. Lifecycle and concurrency

An administrator creates a **draft**, then **publishes**, then may **retire**. A
published version is never edited and never reactivated; restoring earlier terms
is a new version. Retirement never rewrites the activation window — selectability
is `lifecycle_state = 'published'` **and** the instant falling inside the window,
two live conditions, exactly as ADR-041 §5 already decided.

**The database clock sets publication.** `published_at` and
`activation_starts_at` are set from the database in the publishing statement.
Retirement likewise sets `retired_at` from the database clock, which the
corrected effective-interval expression above depends on.
**The ordinary runtime route accepts no activation-start value at all** — not an
optional one, not a validated one. A genuinely historical import is
migration-only, separately audited, and unreachable from any public or admin
route.

Overlap is decided by PostgreSQL, not by an application check. Assignment and
resolution both occur inside the caller's transaction.

**R5 — linearization during enrolled order creation.** *(Added 2026-09-07. The
sentence above says where resolution happens and not what decides a race.)*
Each row below names the database operation that decides the outcome; "whichever
commits first" is not a mechanism.

| Race | Mechanism | Acceptable outcome |
|---|---|---|
| Order creation reading the current assignment | `SELECT … FOR SHARE` on the current assignment row | A concurrent supersession **waits** until the order transaction ends, so the order cannot snapshot a key superseded mid-transaction. The order is a reader, so `FOR UPDATE` would be wrong |
| Order creation reading the resolved policy version | `SELECT … FOR SHARE` on that version row | Retirement is an `UPDATE` of `lifecycle_state`/`retired_at` on that row and therefore **waits**. Without the share lock the version could be retired between resolution and the schedule insert |
| Assignment supersession racing another supersession | Compare-and-swap `UPDATE … WHERE superseded_at IS NULL`, then insert; the **partial unique index on the current row** is the guarantee | Exactly one wins. The loser sees `affected !== 1` (or the unique violation) and is refused readably; the index decides, not the read |
| Two order creations for one booking | The **existing unique index** on the order's booking source | Unchanged by `#41d-2`. It remains the order-creation idempotency arbiter |
| Affiliation changing during order creation | **No lock, and no re-read.** R3's single seller-party selection | The value selected at the offering-read statement is the one written and passed on. Locking `business_staff` would be the wrong repair for a value that must simply not be read twice |

Offering and affiliation are **not** re-read or locked after the seller party has
been selected once; a second read is the defect R3 removes, not a race to
serialize.

**An assignment binds a stable key; an order snapshots an exact version.** Order
creation resolves the published version of the assigned key whose window contains
the database instant, computes the amounts, and writes key, version and amounts
into the immutable schedule. A later publication or retirement changes what the
*next* order resolves and changes **nothing already written**. Binding the key
rather than a version is what lets an administrator re-publish forward without
migrating a single assignment — the trade `V33-DEC-027` already made for the
booking-credit schedule key.

### 5. Authorization and audit

**Publication** stays on the privileged `bc_manage_commercial_plans`, which
already carries the live-revocation re-check and `libs/audit`'s refusal to boot
when a mutation gated on it declares no audit action. Routes join the existing
`CommercialCatalogueController`, which declares the capability on the class — a
second controller would be a second place the guard could be forgotten.

**Assignment** gets one new **non-privileged** capability,
`bc_manage_own_collection_policy`, added in `#41d-2` and granted through the
existing seller-role lifecycle. Reusing `bc_manage_own_subscription` would
silently widen an already-granted capability into a second commercial surface.

**A capability is never ownership.** `workspaceRef` is opaque, recomputed from
live-owned parties on every request, and nothing is looked up *from* a reference.
Staff affiliation grants nothing: an affiliated professional owns neither party,
so a salon's assignment is **unreachable**, not merely refused.

**Audit** actions are a closed set — `commercial.collection_policy_created`,
`…_version_published`, `…_version_retired`, `…_assigned`, `…_assignment_superseded`
— each with a mandatory reason, **one row per real mutation, written in the
mutation's own transaction**. A rolled-back publication leaves none. Reads are not
audited.

### 6. Rollout and truthfulness

The clean migration creates **zero policies and zero assignments** and introduces
**no seed, default or fallback value** of any kind.

**`#41d-1` changes no order behaviour.** It adds publication and nothing else.

**`#41d-2` is a dark launch**, and the boundary is the load-bearing part:

- an **unenrolled** party keeps today's exact path — `full_payment_online`, full
  collectible, null policy triple — which `ck_ops_policy_reference` permits and
  `V33-DEC-022` Ruling 3 already blessed as what the flow actually does;
- an **enrolled** party must resolve an assigned eligible policy, and **fails
  closed** if it cannot;
- there is **no "use full online when the lookup failed" fallback** for an
  enrolled party. An unversioned commercial outcome produced *after* a failure is
  precisely the silent default `V33-DEC-028` Ruling 8 exists to forbid.

*(**R2, added 2026-09-07.** "Enrolled" and "unenrolled" above mean exactly
"has a current assignment row" and "has none" — there is no separate marker, and
no path clears a row to move a party back. `policy_accepted_at` remains
**independently nullable and is populated by neither child**; the resolution
instant is never renamed into acceptance. Per-service override stays deferred
behind #44, and #42, #43, #47, #95, #99, every commercial value and all Legal
copy remain out of scope for both children.)*

**Exit criteria for removing the legacy path**, measurable and requiring no
numeric policy:

1. the count of active seller parties with at least one order in the trailing
   window and **no** enrollment row reaches zero;
2. that count is served by a **non-mutating** query an operator can run;
3. no order has been written on the legacy path for a full observation window;
4. the removal is its own story with its own decision — **not** a flag flip
   inside `#41d-2`.

**Key and version may be recorded without acceptance.** `policy_accepted_at`
remains null until #42 and Legal implement approved copy and a real acceptance
flow. Neither child writes it, and no child renames the resolution instant to
mean it.

### 7. Refusals, privacy and non-goals

**One public refusal.** A missing or unavailable policy, an absent or retired
version, a foreign or malformed `workspaceRef`, an unowned, deleted, suspended or
revoked target, and a concurrent invalidation all return the **same** stable,
non-enumerating body — the shape `CreditPurchaseUnavailableException` already
sets, where seven causes share one code and one Persian message so the catalogue
cannot be enumerated one refusal at a time. Internal audit and metrics may keep a
closed cause vocabulary carrying **no identities and no policy values**.

**The browser projection is unchanged.** `OrderPaymentScheduleViewV1` keeps
serving the mode and all three amounts and keeps omitting `policyKey`,
`policyVersion` and `policyAcceptedAt`, for the reason its docblock already
gives: a receipt shows the amounts terms produced, not the terms' identity. No
actor id is exposed by any read, matching the catalogue controller's existing
rule.

**Privacy.** Both new tables are claimed in the commercial subject-data contract
with an explicit disposition and reason; export and erasure behaviour is asserted
truthfully, and the exact-set test fails if a table is added without a claim.

**Non-goals, by issue.** Cancellation, reschedule, no-show, dispute, retention and
customer copy — **#42** (`gate:legal`). Commission, pending funds, reserve,
settlement release and reversal — **#43** (`gate:external`). Real provider
collection, payout and production activation — **#47**. Paid custom-purchase
activation — **#99**. Global booking-credit enforcement — **#95**. Per-service
policy override — deferred behind **#44**, because `provider.services` is owned by
a professional (`provider/20260820000002_create_provider_schema.sql:40-42`) while
the booking is sold by the business that professional is affiliated with
(`apps/api/src/composition/port-adapters.ts:60-68`), and no precedence rule
repairs an ownership mismatch.

**And no commercial value.** No enabled mode set, percentage, fixed amount,
minimum, maximum, rounding rule or base choice is introduced by either child, in
any form. The existing repository check that makes this enforceable rather than
aspirational (`no-hardcoded-allowance.spec.ts`) is extended to cover them.

## Requirement-to-test matrix

Every row names the mechanism and the evidence. A row without a **non-vacuity
control** is not evidence.

| # | Requirement | Verification | Non-vacuity control |
|---|---|---|---|
| 1 | Published version immutable; retired never revived | Real-PostgreSQL raw `UPDATE`/`DELETE` against a published and a retired row | Drop the trigger in a probe; the test must fail |
| 2 | Non-overlapping windows per key | Two concurrent publications over one interval; exactly one commits | Remove the exclusion constraint; both commit |
| 3 | Non-retroactivity | Publish attempting a past `activation_starts_at`; refused by the database | Relax the CHECK; the backdated row lands |
| 4 | Route accepts no activation-start | Route-table and DTO assertion that the field does not exist | Add the field in a probe; the assertion fails |
| 5 | Deposit shape and percentage-base conditionality | Raw SQL inserting a deposit in the wrong mode, and a percentage without a base | Drop each CHECK independently |
| 6 | Exact arithmetic | Contract tests at rounding boundaries, at the minimum and maximum clamps, and at the money bound | Replace floor with rounding; boundary cases fail |
| 7 | Zero-policy boot and request | API boots with zero rows; every route behaves correctly; no order behaviour changes | Seed one policy in a probe; the "unchanged" assertion fails |
| 8 | Enrolled party fails closed | Enrolled party with no resolvable policy is refused; **no order is written** | Add a fallback in a probe; the refusal test fails |
| 9 | Unenrolled party unchanged | Byte-identical schedule row and response versus the pre-change baseline | Enroll the party; the equality fails |
| 10 | Ownership and adversarial staff | Affiliated staff, dual owner, foreign `workspaceRef` — each refused identically | Resolve via affiliation in a probe; staff succeeds |
| 11 | Capability live revocation | Withdraw the capability mid-token; the next publication is refused | Remove it from `PRIVILEGED_CAPABILITIES`; the stale token succeeds |
| 12 | Audit atomicity | Rolled-back publication and rolled-back assignment leave **no** audit row | Detach the audit write; a row survives the rollback |
| 13 | Snapshot stability | Retire and republish; every existing order schedule is byte-identical | Resolve live in a probe; the comparison fails |
| 14 | Historical compatibility | Existing orders, captures and refunds unchanged after the constraint replacement | — (baseline comparison is the control) |
| 15 | Identical refusal bodies | Every cause returns the same status and body | Differentiate one cause; the equality fails |
| 16 | Query count | Order creation adds a bounded number of queries; no N+1 | Add a per-item lookup; the bound fails |
| 17 | ADR-027 coverage | Exact-set assertion; export and erasure truthfulness | Add a table without a claim; the assertion fails |
| 18 | Migrations | Clean apply, then rerun reports `Applied: 0`; isolated-cluster role contract; restore rehearsal with the role contract re-checked on the restored database | — |
| 19 | Suites | Full fast suite and the real-PostgreSQL suite, **zero skips**, before any PR | A skipped test is a failing gate |
| 20 | Production container | Image builds and boots under `NODE_ENV=production`; health and readiness 200; new routes 401 unauthenticated with a 404 control; runtime path resolution asserted | — |
| 21 | Logs and secrets | Canary-proved detectors; no policy value, workspace reference or administrator id in any log line | Plant a canary; the detector must find it |

## Migration ordering

1. **ADR-048 alone** — this file, no schema and no code. *(This PR.)*
2. **#83 (`#41d-1`)** — the collection-only contract; the two `commercial` tables
   with their CHECKs, exclusion constraint and triggers; the admin publication
   routes on the existing controller; the subject-data claims; the extended
   repository check. **No commerce change, no assignment, no order behaviour
   change.**
3. **#104 (`#41d-2`)** — the assignment table and owner routes; the new
   capability; the resolver port and its composition binding; the
   `ck_ops_policy_reference` replacement; the order-creation integration behind
   the enrollment boundary; the legacy-path metric.
4. **Later, its own story and decision** — remove the legacy path once §6's exit
   criteria are met.

Step 3 must not begin before step 2 is merged: the assignment references a policy
key that must already be publishable, and the constraint replacement is only
honest once a key and version can actually be resolved.

## Consequences

- **Positive.** Every commercial parameter in this family becomes an
  administrator-published immutable version with a database-enforced window, and
  no number reaches an order from code. The order snapshot gains its missing
  meaning without gaining a false one.
- **Positive.** The dark launch means the story that touches live bookings can
  ship and be observed without a flag that rewrites anything already written.
  *(**Corrected 2026-09-07 by R2.** This sentence originally read "…ship, be
  observed and be reverted by clearing an assignment, without a flag…". Clearing
  an assignment is **not** an authorized rollback: it would return an enrolled
  party to the legacy full-online path, which is exactly the post-lookup fallback
  §6 forbids. The dark launch is reverted by **not enrolling further parties**,
  and an enrolled party's failure is a refusal, never a downgrade. The original
  wording is preserved here as history.)*
- **Negative, disclosed.** For a period, two order paths exist. That is the cost of
  not stopping every booking on merge, and §6's exit criteria are what stop it
  becoming permanent.
- **Negative, disclosed.** `BookingCommercialTermsV1` and the new collection-only
  contract coexist until #42 and #43 land theirs. The composition of the three is
  a later decision, deliberately not pre-empted here.
- **Negative, disclosed.** An order can record which policy priced it while
  `policy_accepted_at` stays null. That is the honest state — the platform
  selected terms, and no customer has accepted approved copy, because none exists.

## Open gates

- Approved Persian customer-facing copy, its version and a real acceptance flow —
  `V33-DEC-017`, **#42** with Legal. Until then `policy_accepted_at` stays null.
- Which collection modes may actually be enabled, and every deposit bound, base
  choice and rounding value — **unpublished**, administrator-supplied, tracked on
  #83. Engineering chooses none of them.
- Cancellation, no-show, dispute and retention outcomes — **#42**.
- Commission, pending funds and settlement — **#43**.
- Real provider collection and settlement — **#47**.
- Per-service override precedence and ownership — **#44**.
