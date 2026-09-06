# BeauClick Product Backlog Index

The live backlog is maintained in GitHub Issues. This file records the programme
structure and prevents phase names from drifting between the roadmap, milestones,
and issue labels.

## Live views

- [Backlog Dashboard](https://github.com/itsmyfinance77-dev/BeauClick/issues/2)
- [V3.2-C full backlog](https://github.com/itsmyfinance77-dev/BeauClick/issues?q=is%3Aissue+milestone%3AV3.2-C)
- [Decisions awaiting closure](https://github.com/itsmyfinance77-dev/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Adecision)
- [Ready work](https://github.com/itsmyfinance77-dev/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready)
- [Work in progress](https://github.com/itsmyfinance77-dev/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ain-progress)
- [Blocked work](https://github.com/itsmyfinance77-dev/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ablocked)

A GitHub Project may provide additional visual views later, but it is never the
source of truth. Issues, labels, milestones, and the generated dashboard remain
authoritative so progress measurement does not depend on a particular UI or
account-level Project permission.

The three right-hand columns are intentionally separate. Closing a milestone or
delivering its Story Points never creates a tag and never enables production.

| Milestone | Outcome | Engineering | Release | Production enablement |
|---|---|---|---|---|
| V3.2-C | Referral and Wishlist | **Complete 2026-09-02 — 59/59 Story Points** | Unreleased; no `v3.2.0` tag is authorized | Backend only; external/legal and frontend gates remain |
| V3.2-D | Professional CRM and Delegation | Planned; product decisions required | Not applicable | Not enabled |
| V3.2-E | B2B Quotes and Campaigns | Owner-gated; payment gate applies to settlement | Not applicable | Not enabled |
| V3.2-F | Payout and Calendar Automation | Predominantly external-gated | Not applicable | Not enabled |
| V3.2-G | Evidence-Gated Scale | No commitment without evidence | Not applicable | Not enabled |
| V3.3 | Product Maturity Programme | Active foundation: #39, #40 (`#40a`), #56 (`#56a`), #69 (`#56b`), #72 and #75 complete; epic #38 in progress; Story #41 decomposed by `V33-DEC-022` into #41 (`#41a`), #81 (`#41b`), #82 (`#41c`) and #83 (`#41d`) and re-estimated 13 -> 42 (#82 raised 8 -> 13 by `V33-DEC-024`); #41 (`#41a`), #81 (`#41b`) and #82 (`#41c`) complete, #83 (`#41d`) gated; #58 split by `V33-DEC-025` into `#58a` (13, **complete**) and `#58b` (3, blocked on #46); #57 split by `V33-DEC-026` into `#40c-1` (#57, **complete** at 13 after `V33-DEC-027` re-estimated it 8 -> 13) and #99 (`#40c-2`, 5, blocked on #47); bug #97 (2) complete; commercial structure ratified and **#46 closed** 2026-09-06 by `V33-DEC-028`, which moved #83 (13) and #95 (`#58b`, 3 -> 5) to Ready and re-estimated #43 13 -> 21; #83 then split 2026-09-06 by `V33-DEC-029` into `#41d-1` (#83, 13, Ready) and #104 (`#41d-2`, 8, proposed) | No tag authorized | Real money blocked by #47; every commercial value and all legal copy remain **unpublished**, now tracked on #83, #42 (Legal), #43 and #47 rather than #46 |
| V3.4 | Conditional Expansion Programme | Written owner decision and evidence required | Not applicable | Not enabled |

V3.2-A and V3.2-B are completed historical milestones but are deliberately
excluded from the initial velocity baseline because they were not estimated in
this system before delivery.

## Adoption baseline

- Measurement begins with V3.2-C.
- No forecast is considered calibrated until three cycles have completed.
- The first refinement pass may change provisional V3.2-C estimates before any
  implementation story enters `status:in-progress`.
- The Backlog Dashboard issue is the live burn-up/reporting surface.

## V3.2-C reconciliation, 2026-08-30

The first refinement pass anticipated above has now happened. The product owner
closed the V3.2-C decisions (`V32-DEC-016` … `V32-DEC-021`, the new
`V32-DEC-033`, and `V32-DEC-032`) and approved a re-estimation. **No
implementation story was started, and no velocity is claimed or implied.**

Scope moved from a provisional **54** points to **59**, and the movement is
scope discovery rather than inflation — two stories were found to combine
separable outcomes with different triggers, and one was found to overlap
another:

| Track | Before | After | What changed |
|---|---:|---:|---|
| Decisions | 12 | 12 | Unchanged. |
| Wishlist engineering | 13 | 10 | The unavailable-target projection moved out of the persistence story into the discovery story that already owned the port; the persistence story dropped from 8 to 5. |
| Referral engineering | 21 | 25 | The code/attribution story and the qualification/reversal story each split into two 5-point stories. Attribution is a separate problem because the platform has no signup event; reversal has a different trigger, a different port, and a different open question. |
| Design | 6 | 10 | Both synchronisation stories rose from 3 to 5 on state and surface count. |
| Closure | 2 | 2 | Gains identifier and register reconciliation in its checklist. |
| **Total** | **54** | **59** | |

Two backlog-hygiene rules this pass exercised, recorded because they are easy
to get wrong:

- A `type:decision` issue closed as a record rather than as delivered work
  carries **no** story-point label and **no** status label, but it still needs a
  type, a priority, and a milestone — an item without a milestone is a
  data-quality warning whether it is open or closed.
- Decision effort is counted once. `V32-DEC-032`'s closure issue is unpointed
  because its effort is already carried by issue #6 and by the decision packet.

## V3.2-C final closure, 2026-09-02

- Final scope: **59 Story Points**.
- Delivered: **59 Story Points (100%)** after Stories #14 and #15.
- Data-quality warnings: **0**.
- V3.2-C is the first completed measured cycle; it is evidence for future velocity but does not by
  itself satisfy the three-cycle calibration rule.
- External referral delivery channels, approved public/legal copy, and public business profiles
  remain tracked gaps and are not silently counted as milestone delivery.

## V3.3-A Story #40 decomposition, 2026-09-02

The product owner ratified the **structure** of `V33-DEC-009` and `V33-DEC-010`
after reviewing the Story #40 readiness packet. Commercial values, legal terms,
accounting treatment and external activation remain open under #46 and #47, and
**no implementation story was started**. No velocity is claimed or implied.

The readiness review found Story #40 was carrying four separable outcomes with
different triggers, dependencies and evidence, so it was decomposed rather than
delivered as one 13-point item:

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #40 (`#40a`) | 13 | 8 | Admin-versioned plan and price catalogue: immutable versions, activation windows, tier schedules, the `D-7` zero-price base workspace, administrator capability, audit and mandatory reason. No seller-facing purchase or consumption. |
| #56 (`#56a`) | — | 8 | Subscription foundation: schema, snapshotted subscriber party, `D-7` backfill and lazy ensure, plan-included grants, audit and privacy. Depends on #40. **No seller-facing route.** No payment collection. |
| #69 (`#56b`) | — | 8 | Seller subscription surface: a workspace COLLECTION with an opaque `workspaceRef`, explicit initialization, history, published plans, zero-price selection and cancellation, `bc_manage_own_subscription`. Re-estimated 5 -> 8 by `V33-DEC-019` after the readiness audit found the singular contract unimplementable for a dual owner. Depends on #56. No paid activation. |
| #57 (`#40c`) → `#40c-1` | — | 5 -> 8 -> **13** | Custom booking-credit purchase **record** and immutable price snapshot. Depends on #40; requires ADR-047 before schema or code. **Split and re-estimated 2026-09-06 by `V33-DEC-026`:** the story's paid half cannot be written because **no gateway adapter exists in the repository** — the only provider is the sandbox, disabled under `NODE_ENV=production` — while the purchase record and its snapshot are fully buildable against an administrator-published schedule with no commercial value chosen by engineering. This child writes **no grant of any kind**, its lifecycle is `awaiting_payment | abandoned`, and neither state confers entitlement. Reuses `bc_manage_own_subscription` and `workspaceRef`; adds no capability, order, payment intent, ledger entry, event or provider. **Re-estimated 8 -> 13 on 2026-09-06 by `V33-DEC-027`**, which answered a question `V33-DEC-026` left open: nothing selected WHICH `booking_credit` schedule prices a quantity, because several are legal and the anti-overlap constraint is key-scoped. The administrator now binds a nullable, stable schedule key to an immutable plan version, the subscription snapshots it at activation, and each request resolves that key's version active at the request instant. Existing `D-7` plan versions and subscriptions stay null and are **not** backfilled, so this story ships safely unavailable. |
| #99 (`#40c-2`) | — | **5** | Paid activation of a custom booking-credit purchase: a dedicated authoritative purchase-payment fact, a verified adapter boundary the commercial domain cannot self-attest to, and one atomic transition from that fact to a `custom_purchase` grant. Created 2026-09-06 by `V33-DEC-026`. Widens `ck_booking_credit_grants_source`, replaces `uq_booking_credit_grants_once` with a **partial** index on `source = 'plan_included'` — the current constraint permits each seller exactly one custom purchase for ever — adds `UNIQUE (purchase_id)` and leaves `uq_bcg_identity` untouched. Depends on #57 and **#47**; blocked until a real rail exists. |
| #58 (`#40d`) → `#58a` | — | 8 -> **13** | Atomic consumption at first `confirmed` and idempotent return. Depends on #56 and the mandatory transaction seam #81 shipped; `V33-DEC-023` Ruling 8 fixes that seam's shape (mandatory, non-optional, caller's `EntityManager`, booking id only, no client-supplied owner/party/quantity) and this story replaces its no-op binding with real consumption. **Split and corrected 2026-09-06 by `V33-DEC-025`:** re-estimated 8 -> 13; **#57 is no longer a prerequisite** — the balance model reads any immutable grant row; the zero-collectible-only seam becomes one confirmation-wide port invoked from **both** confirmation paths; and enforcement is **selective**, active only for a party holding a positive grant, because the seeded `D-7` grant is zero and global enforcement would refuse every seller's next confirmation. Global activation is `#58b`. |
| `#58b` (#95) | — | 3 -> **5** | Global booking-credit enforcement activation: the explicit switch from `#58a`'s selective enforcement to fail-closed, plus its rollout proof. Created 2026-09-06 by `V33-DEC-025`. Depends on `#58a`. Redesigns no schema, consumption algorithm or return model. **Corrected and unblocked 2026-09-06 by `V33-DEC-028` Ruling 10:** the claim that no production-positive grant source is reachable was stale — an administrator may publish a zero-price plan version carrying a positive `included_booking_credits` today — so the real gap was the rollout treatment. This story now owns it, with no synthetic backfill: existing `D-7` sellers stay legacy-exempt until explicitly transitioned, the activation command fails closed while any eligible active seller remains unintentionally legacy-exempt, offers a non-mutating preview and count, retains a persistent audited emergency kill switch, and only then activates atomically. Re-estimated 3 -> 5 and moved to Ready. |
| **Total** | **13** | **58** | Net V3.3 scope movement **+45**. Was 53; `V33-DEC-027` raised #57 8 -> 13. |

`#40b` was split a second time on 2026-09-03 (`V33-DEC-018`), after the Story #56
readiness audit found it bundled two separately deliverable outcomes. #56 keeps
its 8 points and its number as the foundation; #69 (`#56b`) carries the seller
surface. The foundation is provable end to end with no seller-facing route at
all, so it can land while the capability and audit-charter questions that only
affect those routes are still being settled.

This is **scope discovery, not velocity loss**. The original 13 points estimated
one story that could not have satisfied its own Definition of Ready: three of
the four outcomes depend on facts the first one has to create, and the fourth
depends on a capability that belongs to a different story entirely.

Three corrections were recorded with the decomposition:

- **Free booking is not a zero service price.** `V33-DEC-001` means the customer
  pays no separate BeauClick booking fee. Under `pay_at_venue` the full service
  price may be non-zero while the platform-collectible amount is zero. The
  no-online-collection confirmation path therefore belongs to Story #41, and no
  `#40-pre` story was created for a `totalToman === 0` branch. The existing
  zero-total-order defect stays visible in #41's acceptance criteria.
- **#47 was being read too broadly.** It blocks real paid collection and
  settlement. It does not block the plan catalogue, immutable versions, the
  zero-price base workspace, entitlement grants, sandbox consumption/return or
  PostgreSQL concurrency tests, so `gate:product` was removed from #40 while
  #46 and #47 both stay open.
- **Story #41's estimate stays provisional.** It requires its own readiness and
  re-estimation audit before implementation, because #58 now depends on it.

One backlog-hygiene rule this pass exercised: a structural decision closing does
not close its decision issue. #46 stays `status:decision` and keeps its 5 points
because the commercial values it owns are untouched.

*(Superseded 2026-09-06 by `V33-DEC-028`, which closed #46 itself as a structural
product decision. The rule above is still correct for the pass it describes: what
changed is that #46's own structural question was finally decided, not that its
values were published. Every value it carried remains `OPEN / UNPUBLISHED` and moved
to #83, #42, #43 and #47. #46 keeps `sp:5` and its 5 points now count as done.)*

## V3.3-A Story #40 (`#40a`) delivered, 2026-09-02

8 Story Points. The administrator-versioned plan and booking-credit pricing
catalogue, decided in
[ADR-041](../roadmap/v3/adr/ADR-041-commercial-plan-and-price-catalogue.md) before
any schema or code was written.

What it delivered: the `commercial` schema on the shared application cluster;
immutable plan and price-schedule versions with a one-way
`draft -> published -> retired` lifecycle enforced by database triggers;
activation-window non-overlap enforced by PostgreSQL exclusion constraints rather
than by application code; immutable tier schedules with gap-free coverage checked
at publication and exact integer resolution; the `D-7` base workspace as a
published, zero-price, automatically assignable plan version reached through a row
property so no production code names it; the privileged
`bc_manage_commercial_plans` capability with live revocation; and audit records
with a mandatory reason written in each mutation's own transaction.

What it deliberately did not deliver: any seller-facing subscription, purchase,
grant, consumption or return (#56, #69, #57, #58); any recurring billing, gateway or
external provider; any commercial event or `ServiceName` member; any frontend; and
any production price. No allowance, including 200, exists as a code constant,
default, fallback or seed, and a repository check enforces that rather than a
reviewer having to.

#46 and #47 are untouched. Every commercial value remains open, and closing the
base-workspace definition under #46 will publish a NEW `D-7` version rather than
edit the seeded one, because the model forbids editing.

## V3.3 Bug #72 re-estimated, 2026-09-04

5 -> 8 Story Points, by
[`V33-DEC-020`](../roadmap/v3.3/V3.3_DECISION_REGISTER.md). Not a re-scoping: the
readiness audit found a **second defect** on the same boundary as the filed one,
and the two cannot be fixed apart.

The filed defect is that `/api/v1/me/finance` resolves one party per caller,
business-first, so a dual owner cannot reach their professional earnings. The
second is that the same resolver follows an active `business_staff` affiliation,
so an affiliated professional reads the **employing business's** receivable,
settlement, outstanding balance and ledger. Both come from using
beneficiary/seller-party resolution as read authorization, which is correct for
attribution (ADR-023 §3) and wrong for permission.

The decision keeps #72 as one issue, adds the additive workspace-aware route
family alongside the four singular routes, and reuses Story #69's `workspaceRef`
unchanged through a shared, domain-neutral primitive. It requires no migration,
writes no row of any kind, and deliberately does **not** enforce
`bc_view_own_finance` — no complete production role-grant lifecycle makes that
capability reliably present in a seller's token, so enforcing it would lock
legitimate sellers out.

That capability gap is recorded as **#75** rather than folded in: the seller
capabilities exist, but account resolution assigns only `customer` and no
self-service path grants `professional` or `business`, so every seller
capability is currently inert. #57, #58, #41, #46 and #47 are untouched.

## V3.3 Bug #75 re-estimated, 2026-09-04

5 -> 8 Story Points, by
[`V33-DEC-021`](../roadmap/v3.3/V3.3_DECISION_REGISTER.md). Not a re-scoping: the
readiness audit found the defect is **active rather than latent**, and that
repairing it needs a trigger in two domains plus a backfill.

Story #69 enforces `bc_manage_own_subscription` on three mounted, unflagged
production routes while account creation grants only `customer`. A genuine
seller is therefore refused `403` on subscription initialization, plan selection
and cancellation, and never receives the base `D-7` workspace. The filed issue
recorded "no user-visible breakage"; that is superseded. The refusal reaches no
BeauClick-shipped screen only because the in-repository web client has no
subscription surface, which is a property of the client rather than of the API.

The decision keeps #75 as one issue. The `professional` and `business` roles are
granted atomically on ownership creation — never on verification, never from
`business_staff`, never from a caller-supplied field — with an idempotent
ownership-only backfill for existing owners. `customer` is never removed, live
ownership remains the authorization boundary, a grant becomes effective at the
next access-token issuance, and no new revocation machinery is built. Role
provenance is deliberately excluded and left to a future additive,
migration-backed decision if multiple grant sources ever need to coexist.

ADR-023 is amended rather than reversed: beneficiary resolution may still follow
affiliation, while workspace authorization and owner-role assignment follow
ownership. Business-scoped staff roles and permissions remain **#44's**
territory. #57, #58, #41, #46 and #47 are untouched.


## V3.3 Story #41 decomposed and re-estimated, 2026-09-05

13 -> 37 Story Points across four children, by
[`V33-DEC-022`](../roadmap/v3.3/V3.3_DECISION_REGISTER.md). Net V3.3 scope
movement **+24**. The 13 was explicitly provisional: #41 acquired the
zero-collectible confirmation capability in the `V33-DEC-001` correction of
2026-09-02, after it was first sized, and its own body required a readiness audit
before implementation.

That audit found #41 bundled four independently reviewable outcomes, and that the
three-amount vocabulary it was assumed to need **already exists and is already
tested** — `collectionBreakdownV1()` in `packages/commercial-policy-contract`
computes the platform-collectible and venue-balance split for all three modes.
What is missing is a consumer: `CommercialPolicyModule` is composed into no
`apps/api` module.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #41 (`#41a`) | 13 | 8 | Immutable one-to-one `commerce.order_payment_schedules` snapshot, truthful full-online backfill, additive three-amount browser/receipt fields, and wiring the existing contract into the API. Represents all three modes; **enables none**. Changes no `OrderStatus`, `OrderPaid`, `totalToman`, refund, ledger or public response meaning. |
| #81 (`#41b`) | — | 8 | Zero-collectible confirmation orchestrator with no public confirm route and no fabricated intent, attempt, event or receivable, plus the **mandatory** composition seam #58 hooks. Contract ratified 2026-09-05 by `V33-DEC-023`: the order takes the explicit status `online_collection_not_required`, no new event is added, and the transaction transitions the order before confirming the booking (H-a). ADR-044 is required before schema or code. |
| #82 (`#41c`) | — | 8 -> **13** | Sandbox deposit execution; intent amount becomes the platform collectible; refund ceiling and financial projection limited to collected money. Contract ratified 2026-09-05 by `V33-DEC-024`: a partial capture emits a distinct `OrderCollectionCaptured v1` rather than reinterpreting `OrderPaid v1`; additive `online_collection_completed` state; additive `collected_total_toman` replaces `total_toman` as the refund ceiling; the ledger receives collected money only. Re-estimated 8 -> 13 and requires ADR-045 before schema or code. |
| #83 (`#41d`) -> `#41d-1` | — | 13 -> **13 + 8** | Database-backed administrator publication and selection of versioned collection policy, fail-closed. Unblocked and made Ready 2026-09-06 by `V33-DEC-028`. **Split 2026-09-06 by `V33-DEC-029`, net 13 -> 21:** the readiness audit found #83 could not populate its own contract honestly — `BookingCommercialTermsV1` requires six values owned by #42 and #43 plus a mandatory copy version that does not exist, `PercentageDepositTerms` carries no calculation base, and `ck_ops_policy_reference` refuses a key/version without an acceptance instant that would be false. #83 keeps its number as **`#41d-1` (13)** and owns publication only, changing no order behaviour; **#104 (`#41d-2`) (8)** owns seller-party assignment and the immutable order snapshot. Per-service override is deferred behind #44. ADR-048 is required before any schema or code. |
| **Total** | **13** | **50** | Delivery order #41 -> #81 -> #82 -> #83 (`#41d-1`) -> `#41d-2`. Was 37; #82 was re-estimated 8 -> 13 by `V33-DEC-024` on 2026-09-05, and #83 was split 13 -> 21 by `V33-DEC-029` on 2026-09-06. |

#41 keeps its number and its Epic #38 relationship, so every existing reference
survives.

The audit also recorded two latent money defects, both harmless only while the
order total and the collected amount are the same number, and both #82's to
correct: the refund ceiling is `refunded_total + amount <= total_toman`, and the
ledger posts the order total as the receivable.

**`V33-DEC-022` closes structure only.** Every commercial and legal value stays
open: enabled collection modes, deposit bounds and rounding values, the
percentage calculation base — which the audit found ratified in no document at
all — cancellation, no-show, reschedule, dispute, settlement, commission, tax and
approved copy. #47 gates real provider collection, settlement and production
activation only, and does not gate #41. #42, #43, #46, #47 and #58 are untouched
apart from #58's dependency now naming #81.

**`V33-DEC-023` closed #81's public vocabulary on 2026-09-05.** The one gate
`V33-DEC-022` Ruling 6 left open is resolved: a zero-collectible order takes the
explicit `OrderStatus` value `online_collection_not_required`, and **no** new
commerce event or `ServiceName` is added, because `BookingConfirmed` already
carries the fact and already has named consumers. The lifecycle is
`pending -> online_collection_not_required -> cancelled`, `paid` stays reachable
only through verified payment, the confirmation transaction transitions the order
before confirming the booking so its lock order matches the gateway callback's,
and no intent, attempt, `OrderPaid`, receivable or refund is created for money
never collected. #81 stays 8 SP, becomes Ready, and needs ADR-044 before any
schema or executable code. It closed no commercial or legal value: #46 and #47
are untouched.

*(#81 was implemented and merged later the same day and is now closed; the
sentence above records what the ratification said at the time.)*

**`V33-DEC-024` closed #82's accounting and event contract on 2026-09-05.** The
gate `V33-DEC-022` Ruling 7 left open — the `OrderPaid` and accounting meaning of
a partial capture — is resolved by **separating the fact** rather than redefining
one: a verified collection below the service total emits a new
`OrderCollectionCaptured v1`, while `OrderPaid v1` keeps its whole-capture
meaning and exact payload and is emitted only for a full capture. Never both, and
deliberately not an `OrderPaid v2`, because the outbox relay dispatches by event
name and ignores `eventVersion`, so a same-name v2 would poison existing v1
consumers.

#82 also gains the additive `online_collection_completed` order state and an
additive monotonic `commerce.orders.collected_total_toman`, set once from the
gateway-verified amount and required to equal the schedule's collectible. That
column replaces `total_toman` as the refund ceiling under a PostgreSQL chain
enforcing `0 <= refunded <= collected <= total`, and the financial ledger
receives collected money only — a venue balance is never a BeauClick receivable,
liability or revenue fact. Execution is schedule-driven with no mode selector and
no part of #83. #82 stays one story, is re-estimated **8 -> 13 SP**, becomes
Ready, and needs ADR-045 before any schema or executable code. It approved no
commercial or legal value: #46, #47 and #83 keep their gates.

## V3.3 commercial structure ratified and #46 closed, 2026-09-06

`V33-DEC-028` closed the long-open commercial decision **structurally, not
numerically**. Every launch value stays explicitly `OPEN / UNPUBLISHED`, no legal
wording was approved or invented, and **Legal did not sign off** — the legal gates
moved to the issues that actually carry them rather than disappearing.

**What the ruling settled.** Every commercial parameter is an administrator-managed
immutable version with non-overlapping effective windows, a one-way
`draft -> published -> retired` lifecycle, privileged publication with live
revocation, and mandatory transactional audit; no commercial number may survive as a
code constant, fallback, seed or environment-variable product truth. Every commitment
snapshots the effective version and the exact money or quantity, and nothing
downstream re-reads live policy. Ordinary administrator publication is **not**
retroactive: the activation instant is database-authoritative and never earlier than
publication. Collection modes stay exactly three, with fixed and percentage deposits
as calculation rules rather than modes. Deposit retention is a cancellation/no-show
outcome owned by #42, bounded by money actually collected and inert before Legal.
Missing configuration fails closed everywhere. Optional four-eyes publication approval
is deferred as a **named future decision**, and no issue was created for it.

**Two verified contradictions were recorded rather than assumed away.**
`FinancialConfig.DEFAULT_COMMISSION_RATE_BP = 1500` and
`FINANCIAL_COMMISSION_RATE_BP` are a deployment-time commercial decision with no
version, window, audit row or capability — #43 must replace them with a versioned
commission policy, and until one is published a new commission-bearing ledger write
fails closed rather than defaulting to 15%. And the **pending-funds model does not
exist**: settlement is an immediate manual administrator action, so #43 builds the
model before any timing value can mean anything.

**Issue transitions.**

| Issue | Before | After | Change |
|---|---|---|---|
| #46 | OPEN, `status:decision`, `gate:product`, `gate:legal`, `sp:5` | **CLOSED**, `sp:5` retained | Structural closure. Status and both gates removed; Legal did not approve, and the legal gates live on #42 and #47 |
| #83 (`#41d`) | `status:proposed`, `gate:product`, `gate:legal`, 13 | **`status:ready`**, 13 | Publishes and selects versioned policy; activates no provider; stays fail-closed. *(Split the same day by `V33-DEC-029` into `#41d-1` at 13 and `#41d-2` at 8 — see the section below.)* |
| #42 | `status:proposed`, `gate:product`, `gate:legal`, 13 | `status:proposed`, **`gate:legal` retained**, 13 | `gate:product` removed; it owns cancellation, no-show evidence, dispute, retention and customer copy |
| #43 | `status:proposed`, `gate:product`, `gate:external`, 13 | `status:proposed`, **`gate:external` retained**, **21** | `gate:product` removed; it now also owns versioned commission policy, retiring the 1500/env fallback, pending funds, reserve/hold, settlement release, reversal/clawback and exact reconciliation |
| #95 (`#58b`) | `status:blocked`, `gate:product`, 3 | **`status:ready`**, **5** | Premise corrected; it now owns the legacy-exempt preview, migration, atomic activation and kill-switch contract |
| #47, #99, #44 | — | **unchanged** | External and legal gates genuinely open; verticals are a separate decision |

**Scope movement.** V3.3 scope moves **208 → 218** (#43 +8, #95 +2) and done moves
**117 → 122**, because closing #46 counts its retained 5 points as delivered. That is
a governance closure, not engineering velocity: no code, schema, migration, route,
contract or test changed, and **no implementation started**.

**ADR-048 is required before the first schema or executable implementation** of
`V33-DEC-028`, and was deliberately not written in the governance change that
recorded the decision.

## V3.3 Story #83 decomposed and re-estimated, 2026-09-06

`V33-DEC-029` split Story #83 after a read-only readiness audit. **Structure, contract and
security only** — no commercial value, no Legal wording, no provider, payment, retention or
settlement was approved or activated, and no implementation started.

**The reason is a fact about the code, not a preference.** #83 could not have populated its
own contract honestly:

- `BookingCommercialTermsV1` **requires** six values owned by other issues — cancellation
  cutoff, late-cancellation and no-show retention, reschedule action and dispute window
  (**#42**), and settlement delay (**#43**) — plus a mandatory `customerPolicyCopyVersion`
  for which no approved Persian copy exists.
- `PercentageDepositTerms` carries **no calculation base**.
- `ck_ops_policy_reference` refuses a policy key and version **without** an acceptance
  instant that would be false today.
- One hard-coded writer serves every order, so a fail-closed path on merge would have
  stopped **every booking on the platform**.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #83 (`#41d`) → `#41d-1` | 13 | **13** | The collection-only contract split; the policy key and version tables; lifecycle, immutability, non-overlap and database-authoritative non-retroactivity; the `{service_subtotal, service_total}` percentage-base vocabulary as required data with no default; privileged audited administrator publication; a zero-row fail-closed foundation; ADR-027 coverage. **Changes no order behaviour.** No assignment, no order integration, no acceptance, no commercial default |
| #104 (`#41d-2`) | — | **8** | Seller-party assignment and the immutable order snapshot: the assignment table and owner routes, the new non-privileged `bc_manage_own_collection_policy`, the manager-scoped resolver port, order integration behind an explicit dark-launch boundary, and the `ck_ops_policy_reference` split into key/version all-or-none with independently nullable acceptance. Depends on #83 |
| **Total** | **13** | **21** | Net V3.3 scope movement **+8**. Done unchanged — this decision completes no story |

**Two things the split deliberately refused to do.** It did not fill the missing contract
fields with zeros, placeholders or an invented copy version — a zero cutoff and a zero
retention are *values*, and a fabricated copy version is *legal metadata*. And it did not
populate `policy_accepted_at` with the resolution instant, which would assert that a
customer accepted terms that do not exist. Acceptance stays #42's, after Legal.

**Rollout is an explicit dark launch, not a fallback.** `#41d-1` changes no order
behaviour. Under #104 (`#41d-2`) an unenrolled legacy party stays on the named full-online /
null-policy path with a stated exit, while an **enrolled** party resolves an assigned
eligible policy or **fails closed** — there is no "use full online when the lookup failed"
path, and no seed or invented full-payment policy is created. That clarifies
`V33-DEC-028` Ruling 8 without weakening it: fail-closed binds from the moment a party is
enrolled.

**Per-service override is deferred behind #44**, not silently promised: `provider.services`
is owned by a professional while the booking is sold by the business that professional is
affiliated with, and no precedence rule repairs an ownership mismatch. No issue was created
for it.

Boundaries unchanged: #42 keeps `gate:legal`, #43 keeps `gate:external` at 21, #47 and #99
stay blocked, #95 is untouched, and #46 was not reopened.

**ADR-048 is required before any schema, contract or executable code**, and must be
committed alone as its own pull request containing exactly one new file.
