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
| V3.3 | Product Maturity Programme | Active foundation: #39, #40 (`#40a`), #56 (`#56a`), #69 (`#56b`), #72 and #75 complete; epic #38 in progress; Story #41 decomposed by `V33-DEC-022` into #41 (`#41a`), #81 (`#41b`), #82 (`#41c`) and #83 (`#41d`) and re-estimated 13 -> 42 (#82 raised 8 -> 13 by `V33-DEC-024`); #41 (`#41a`), #81 (`#41b`) and #82 (`#41c`) complete, #83 (`#41d`) gated; #58 split by `V33-DEC-025` into `#58a` (13, **complete**) and `#58b` (3, blocked on #46); #57 split by `V33-DEC-026` into `#40c-1` (#57, **complete** at 13 after `V33-DEC-027` re-estimated it 8 -> 13) and #99 (`#40c-2`, 5, blocked on #47); bug #97 (2) complete; commercial structure ratified and **#46 closed** 2026-09-06 by `V33-DEC-028`, which moved #83 (13) and #95 (`#58b`, 3 -> 5) to Ready and re-estimated #43 13 -> 21; #83 then split 2026-09-06 by `V33-DEC-029` into `#41d-1` (#83, 13, Ready) and #104 (`#41d-2`, 8, proposed); #104 then split 2026-09-07 by `V33-DEC-031` into `#41d-2a` (#104, 8, Ready) and #115 (`#41d-2b`, 8, proposed); **#44 decomposed 2026-09-06 by `V33-DEC-030`** into an umbrella carrying no Story Points plus five children — #107 (`#44a`, 5, Ready), #108 (`#44b`, 8), #109 (`#44c`, 13), #110 (`#44d`, 13) and #111 (`#44e`, 8) — re-estimated 13 -> 47, a net **+34** with done unchanged; #107 (`#44a`)'s classification cardinality then ratified 2026-09-07 by `V33-DEC-032` — **at most one** vertical, an unclassified business legal, #107 unsplit at 5 SP and **no Story Point moved**; #107 (`#44a`) and #108 (`#44b`) then **complete**, and #109 (`#44c`)'s scoped-staff contract ratified 2026-09-08 by `V33-DEC-033` — a one-member `practitioner_chat` vocabulary, practitioner-specific chat authority, a fully synchronous invitation with no queued phone derivative, and the UUID invite contract replaced — moving #109 to Ready **unsplit at 13 SP** with no point completed and adding **#123** (2, the bounded web-invite frontend follow-up), a net **+2** with done unchanged; #123 then **complete** 2026-09-08; and #110 (`#44d`) **decomposed 2026-09-09 by `V33-DEC-034`** into `#110a` (#110, 5, the resource catalogue), `#110c` (#127, 8, the delivery-location context the platform does not yet have) and `#110b` (#128, 8, assignment and collision, blocked on both) — re-estimated 13 -> 21, a net **+8** with done unchanged; `#110a` (#110) then **complete** 2026-09-09; and `#110c` (#127) itself **split 2026-09-10 by `V33-DEC-035`** into `#127a` (#127, 5, the delivery-location context) and `#127b` (#131, 8, the service resource requirement), with #128 now blocked on **both** — re-estimated 8 -> 13, a net **+5** with done unchanged; `#127a` (#127) and `#127b` (#131) then both **complete** 2026-09-10, done rising 184 -> 197; and #128 (`#110b`) itself **complete** 2026-09-10, done rising 197 -> 205, closing the `V33-DEC-034`/`V33-DEC-035` resource-assignment lineage in full | No tag authorized | Real money blocked by #47; every commercial value and all legal copy remain **unpublished**, now tracked on #83, #42 (Legal), #43 and #47 rather than #46 |
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
| #104 (`#41d-2`) -> `#41d-2a` + #115 (`#41d-2b`) | — | 8 -> **8 + 8** | *(Split 2026-09-07 by `V33-DEC-031`; the description below is the unsplit story. #104 keeps its number as `#41d-2a` and owns assignment only; #115 owns order resolution and the immutable snapshot.)* Seller-party assignment and the immutable order snapshot: the assignment table and owner routes, the new non-privileged `bc_manage_own_collection_policy`, the manager-scoped resolver port, order integration behind an explicit dark-launch boundary, and the `ck_ops_policy_reference` split into key/version all-or-none with independently nullable acceptance. Depends on #83 |
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

## V3.3 Story #44 decomposed and re-estimated, 2026-09-06

`V33-DEC-030` decomposed Story #44 after a read-only readiness audit. **Structure, contract
and security only** — no commercial value, no Legal wording, no schema, no ADR and no
implementation. #44 is now an **umbrella carrying no Story Points**.

**The reason is a fact about the repository, not a preference.** #44 could not have been
started as written:

- `V33-DEC-002` had already ratified `multi_location` and `mobile` as **verticals**, in the
  same closed set as `salon` and `clinic`. A salon that opens a second branch would have had
  to *stop being a salon*.
- #44 asked for an **`owner` scoped role**, which would re-open the exact edit/remove/race
  hazard ADR-023 closed and break the ownership predicate `V33-DEC-020` and `V33-DEC-021`
  rest on.
- #44 asked for **`reception`**, whose whole job is acting on *other people's* calendars —
  while every such route resolves the professional's own owning user.
- #44 assumed a **`finance`** role that `V33-DEC-020` Ruling 2 had explicitly left **open**.
- #44 named **`inventory`** and **`B2B sales`** roles. No inventory, product, stock,
  order-book or wholesale table exists, so they would have authorized nothing.
- #44 cited **"the V3.3-C staff-role decisions"** as a dependency. **No such register entry
  exists.**
- `InviteStaffDto.userId` means a salon cannot invite a receptionist without already knowing
  their UUID, so every role would have shipped administratively unusable.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #44 | 13 | **0 (umbrella)** | Retained OPEN as the parent under #38, converted to `type:epic`, `sp:13` and `gate:product` removed. **Delivers no schema or code and closes only when all five children close.** |
| #107 (`#44a`) | — | **5** | Business classification and operating traits: closed vertical and trait vocabularies, one primary vertical per business *(amended 2026-09-07 by `V33-DEC-032` to **at most one** vertical, with an unclassified business legal — see the 2026-09-07 section below)*, owner-only mutation, transactional audit, ADR-027 claims, a structural proof that classification authorizes nothing, and the `uq_businesses_owner_id` partial-index correction. The **only** Ready child |
| #108 (`#44b`) | — | **8** | Organisation locations with an `active \| suspended \| closed` lifecycle and an opaque `locationRef`. `businesses.city_id` is deprecated **as a service-delivery location**, with the column and all data preserved. No booking behaviour changes |
| #109 (`#44c`) | — | **13** | Scoped staff roles and permissions: the grant store anchored on `business_staff.id`, a **new scoped** verifier port, owner-only grant/revoke with live re-checks, the `business_staff` status vocabulary and CHECK correction, consented non-enumerating invite-by-phone, and the chat practitioner grant. *(Contract ratified 2026-09-08 by `V33-DEC-033`: vocabulary is exactly `practitioner_chat`, the role is practitioner-specific, invitation is fully synchronous with no queued phone derivative, and the UUID invite contract is replaced. Moved to Ready, unsplit at 13 SP — see the 2026-09-08 section below.)* |
| #110 (`#44d`) | — | **13** | Bookable resources and `ex_booking_resource_no_overlap`, assigned in the same transaction as the slot claim. `booking.bookings` byte-identical *(decomposed 2026-09-09 by `V33-DEC-034` into `#110a` (#110, 5), `#110c` (#127, 8) and `#110b` (#128, 8), re-estimated 13 -> 21 — see the 2026-09-09 section below)* |
| #111 (`#44e`) | — | **8** | Scoped **read-only** finance visibility for exactly one business, with every existing #72 finance-security assertion still passing unchanged |
| **Total** | **13** | **47** | Net V3.3 scope movement **+34**. Done unchanged — this decision completes no story |

**Story Points are not double-counted.** The parent carries none; `sp:47` was deliberately
**not** placed on #44. The live backlog report shows V3.3 moving **226 → 260** scope with
**done unchanged at 122**, and zero data-quality warnings.

**Two things the decomposition deliberately refused to do.** It did not deliver
**`reception`'s real job** — a receptionist creating slots, cancelling, rescheduling,
completing or marking a no-show on a practitioner's behalf. That requires opening `booking`
and `provider` to business-scoped delegation, the module ADR-023 was written to protect. It
is a named future story and **no issue was created for it**. And it did not store
`inventory` or `B2B sales` roles, which would be permission strings with no referent.

**`V33-DEC-002` is amended, not reinterpreted.** Its original wording is preserved in the
register with an explicit historical annotation. Vertical is now
`salon | clinic | maison | retail | wholesale | academy`; `multi_location` and `mobile` are
**operating traits** on a separate axis. Neither axis grants any permission, capability,
financial access or booking authority, and `clinic` is a commercial classification carrying
no medical data.

**A documentation defect was corrected.** `README.md` claimed the location model is
`Iran → Province → City → District/Neighborhood` and listed the `business` domain twice, once
claiming it owns locations. The only geography table in the platform is
`provider.locations_cities (id, name, is_launched)`. The README now says what exists and what
#44's children will add; **no planned table is presented as shipped**.

Boundaries unchanged: #45 stays 13 SP and is untouched — it is design work that *consumes*
these contracts. #104's per-service override stays deferred behind #44 and is **not**
absorbed. #42 keeps `gate:legal`, #43 keeps `gate:external`, #47 and #99 stay blocked, and
#95 is untouched.

**ADR-049 is required before any child schema, contract or executable code**, and must be
committed alone as its own pull request containing exactly one new file. It was deliberately
**not** written in this governance change.

## V3.3 Story #104 split into assignment and order resolution, 2026-09-07

`V33-DEC-031` decomposed Story #104 after a read-only readiness recheck against the merged
`#41d-1` code. **Scope only** — no commercial value, no Legal wording, no provider,
payment, retention or settlement was approved, and no implementation started.

**Why.** The story carried two outcomes with different blast radii: choosing a policy, and
pricing every enrolled booking with it. Assignment cannot break a booking; order
integration is the only thing in this family that can. The recheck also found a body gap —
#104 required a seller to supply a stable `policyKey` while giving them no way to learn one,
because the administrator publication routes are class-gated on the privileged
`bc_manage_commercial_plans` — and two engineering defects since bound by the ADR-048
amendment of 2026-09-07 rather than by this card.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #104 (`#41d-2`) → `#41d-2a` | 8 | **8** | Immutable assignment history with one current row per seller party; assignment presence as the enrollment fact, with no marker and no un-enrollment path; supersession that never mutates a key in place; live ownership through the opaque `workspaceRef`, with `business_staff` affiliation granting nothing; the new non-privileged `bc_manage_own_collection_policy`; a seller-readable assignable-policy catalogue exposing only a key and a display name and reusing no administrator route; current-assignment read; one non-enumerating refusal; `FOR SHARE` plus compare-and-swap linearization with same-transaction audit; ADR-027 treatment. **Changes no order, booking, schedule, amount, mode, `policy_accepted_at` or customer-facing response** |
| #115 (`#41d-2b`) | — | **8** | The manager-scoped `ServiceCatalog`/`SellerPartyLookup` repair with the seller party selected once and never re-resolved; the Commerce-owned manager-scoped resolver port bound at the composition root, with no Commercial Policy ORM import; resolution of the active published version at the database clock instant; the immutable snapshot; **derivation of `collection_mode` from the computed amounts** rather than from the policy terms; the `ck_ops_policy_reference` replacement with existing rows byte-identical; the dark-launch boundary, its metrics and its stated exit criterion. Depends on #83 and #104 |
| **Total** | **8** | **16** | Net V3.3 scope movement **+8**. Done unchanged — the split completes no story |

**Recorded route family**, audited against every existing `v1/me/*` namespace for collision
and wildcard shadowing: `GET /api/v1/me/collection-policies` for the catalogue, and
`GET`/`PUT /api/v1/me/collection-policy-assignments/:workspaceRef` for the assignment. No
route accepts a user, party, business, professional, seller, owner or actor id, a policy
version, an amount, a mode or a timestamp.

**ADR-048 governs both children and no new ADR was created.** Its 2026-09-07 amendment
already binds mode derivation, assignment-presence enrollment, the manager-scoped read with
its `READ COMMITTED` precision, the separate resolver, and the `FOR SHARE`/CAS
linearization. `policy_accepted_at` remains independently nullable and is populated by
neither child; per-service override stays deferred behind #44; and #42, #43, #47, #95 and
#99 keep every gate they had.

## V3.3 Story #107 classification cardinality ratified, 2026-09-07

`V33-DEC-032` closed the one question a read-only implementation-readiness audit of #107
refused to answer. **Product meaning and data contract only** — no commercial value, no
Legal wording, no schema, no ADR and no implementation. **No issue was created, closed,
re-estimated or re-pointed**, so Story Points and progress totals are unchanged.

**Why.** `V33-DEC-030` D1 closed the vertical and trait **vocabularies** but never their
**cardinality**, and #107 then required "exactly **one primary** vertical per business,
enforced by a partial unique index". That sentence was unratified and unbuildable in two
independent ways:

- the word *primary* and its partial index are meaningful only if **secondary** verticals
  exist, and nothing in the register, ADR-023, ADR-039 or #107's own D1 says what a secondary
  vertical means, who may set one, whether it is exported under ADR-027, or what reads it;
- **no unique index can require at least one row**, and `BusinessService.create` writes no
  classification at all, so "exactly one" would have made every existing and every newly
  created business non-conforming — inside a story that calls itself a zero-behaviour change.

**What was ratified.** A business has **at most one current vertical**.
`business.business_verticals` is keyed by `business_id` as its primary key, with **no
`is_primary` column** and **no independent row id** whose only purpose is to imply multiple
verticals; "primary vertical" and a partial primary-marker index are explicitly rejected
because they silently introduce secondary verticals with no ratified meaning. An
**unclassified business is legal**, represented by the **absence** of the row — never by a
default, a backfill, an inference or a sentinel member of the closed vocabulary. Existing
businesses stay unclassified until **their owner explicitly sets a classification**, and
**`POST /v1/businesses` is unchanged**: creation neither requires nor accepts a vertical.
Traits remain an independent additive set of zero, one or both of `multi_location | mobile`,
keyed by `(business_id, trait)`. Classification still **authorizes nothing**, and `clinic`
remains a commercial classification carrying no medical data and no medical authority.

**Four engineering obligations were recorded as #107's own, not as new product decisions:**
the `uq_businesses_owner_id` partial active-owner index repair; the `deleted_at IS NULL`
filters in `StaffService.roleFor` and `BusinessService.update`, which must land **atomically
with** that repair, because a partial index otherwise lets one user own a soft-deleted row
and a live row with owner authority over both; **direct** tests for the transactional-audit
criterion, because the privileged-route boot assertion does not cover this non-capability
business surface; and entity-metadata/index alignment, so removing `@Column({ unique: true
})` from `ownerId` cannot leave pg-mem and real PostgreSQL holding contradictory ownership
uniqueness, with real PostgreSQL authoritative for partial-index behaviour.

**Nothing moved.** #107 stays **unsplit at 5 SP**, `status:ready`, milestone V3.3, priority,
track, parent and open state unchanged. #44, #108–#111 and #38 are untouched. `V33-DEC-030`
is amended **only** in its `#44a` cardinality phrase; every other ruling of that card stands
and is not reopened.

**ADR-049 is still required before any child schema, contract or executable code**, must be
committed alone as its own pull request containing exactly one new file, and must now record
`V33-DEC-032`'s rulings verbatim. It was deliberately **not** written in this governance
change, and no #107 implementation began with it.

## V3.3 Story #109 scoped-staff contract ratified, 2026-09-08

`V33-DEC-033` closed the three questions a read-only readiness audit of #109 against
`2306d2275ac019b5300a63eced13f590081fb108` refused to answer by engineering judgement.
**Security and contract only** — no commercial value, no Legal wording, no schema, no new
ADR and no implementation.

**Why.** #109's own acceptance criterion demanded a "closed scoped-role vocabulary" its body
never listed; the chat grant was undefined between business-wide and practitioner-specific;
and the invitation contract had no ratified way to reach indistinguishable timing without
storing something about a person who has no account.

**What was ruled.** **R1** the vocabulary is **exactly one member — `practitioner_chat`**;
no `owner`, `location_viewer`, `location_manager`, finance, reception, inventory, B2B or
global identity role, and a new member needs a later decision **tied to a real consumer**.
**R2** the role is **practitioner-specific, not business-wide** — the booking's
`professional_id` must equal the grantee membership's, and the order's snapshotted seller
business must equal the grant's, with **no third scope form** and the membership's
`professional_id` resolved server-side. **R3** invitation resolution is **fully
synchronous**: no raw phone, hash, encrypted phone, lookup token, pending row, outbox event,
notification or **transient queued record** for an absent, ineligible, duplicate, foreign or
self case; all well-formed cases return `202 {}` byte-identically, malformed stays the
existing `400`, and timing is defended by constant-shape lookups plus a monotonic-clock
duration floor — never by artificial writes, and never claimed as perfect constant time.
**R4** the `InviteStaffDto.userId` contract is **replaced**, with no parallel UUID endpoint;
the new input is exactly `{ phone, role }`. **R5** the audit's remaining engineering
structure is adopted as-is.

**What moved.** #109 goes `status:proposed → status:ready`, **unsplit at 13 SP**, milestone,
priority, track, parent and open state unchanged — 13 points move from Proposed to Ready
within V3.3, and no point is completed. **#123** is created (2 SP, V3.3, `track:design`,
depends on #109) as the bounded frontend follow-up for the prototype web invite screen, which
#109 deliberately does not touch; V3.3 scope therefore rises 268 -> 270 with done unchanged.
#107 and #108 remain closed; #110, #111, #44, #38, #42, #43, #45, #47, #95 and #99 are
untouched.

**No new ADR.** ADR-049 still gates the family; it receives only a dated cross-reference note
in §4 so R2 and R3 are discoverable from it. No ADR-050 was created and no #109
implementation began with this change.

## V3.3 Story #110 decomposed and re-estimated, 2026-09-09

`V33-DEC-034` split #110 (`#44d`) after a read-only readiness audit against
`98b86994d4d840bd49c12835d172d71e7fad915d` found the story coherent and well bound by
ADR-049 §6 in every respect but one. **Structure and contract only** — no commercial value,
no Legal wording, no schema, no new ADR and no implementation.

**Why.** #110's acceptance criteria require automatic server-side resource selection, and
ADR-049 §6.2 requires resources to hang off a location — but nothing in the platform can say
**which location a booking is delivered at**. `CreateBookingInput` carries no location; the
token `location` appears **nowhere** in the `booking` migration directory or anywhere in
`services/booking/src`; `provider.services` binds only to a professional; the only
professional→organisation resolver stops at a **business**; and a business has **0..N**
locations, with ADR-049 §3.5 making a location-less business legal and `V33-DEC-033` R2
having already ratified that **"a location owns no bookings"**. Any implementation would
reduce to first-row selection: green on a single-branch business, and **silently assigning
wrong-branch resources** the day a salon opens its second location.

**What was ruled.** **R1** splits `#44d` into three independently tracked stories. **R2**
closes the resource-kind vocabulary at exactly `room | device | station`, `station` covering
chairs, beds, nail desks and styling positions. **R3** makes catalogue mutation
**owner-only**, adding no scoped-staff role and leaving `SCOPED_STAFF_ROLES` byte-identical.
**R4** makes assignment **optional** and at most one per booking, with no backfill inventing
a location or resource and no `provider.services` change. **R5** addresses resources by an
opaque `resourceRef` on the API while the booking↔business module boundary keeps a raw opaque
UUID through a port. **R6** authorizes **no** customer-facing resource surface of any kind.
**R7** bounds `#110a` and **moves the blocked-close criterion to `#110b`**, because during
`#110a` no assignment exists and the test would pass for the wrong reason. **R8** sets
`#110c`'s direction as availability-slot-level context while authorizing **no** column or
table, and records it `status:proposed`. **R9** bounds `#110b` and forbids it starting before
`#110c` supplies delivery context.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #110 (`#110a`) | 13 | **5** | Location resource catalogue and lifecycle: `business.location_resources`, the required `UNIQUE (id, business_id)` target on `business.locations`, same-business composite-FK integrity, the closed `room \| device \| station` vocabulary, lifecycle, owner-only CRUD, `resourceRef`, audit and the ADR-027 `retained` disposition. **Ready** |
| #127 (`#110c`) | — | **8** | Delivery-location and resource-selection context — the authoritative edge that must exist before automatic assignment is possible. Direction is slot-level context; **no column or table is yet authorized**. `status:proposed` pending its own readiness audit *(split 2026-09-10 by `V33-DEC-035` into `#127a` (#127, 5) and `#127b` (#131, 8), re-estimated 8 -> 13 — see the 2026-09-10 section below)* |
| #128 (`#110b`) | — | **8** | Booking resource assignment and collision prevention: `booking.booking_resource_assignments`, `ex_booking_resource_no_overlap` with half-open `[)` semantics, same-transaction claim with deterministic lock ordering, two-way rollback, `23P01` → the existing non-enumerating refusal, blocked retirement and closure, and ADR-027 `subject_data` pinning. **Depends on both** #110 and #127 |
| **Total** | **13** | **21** | Net V3.3 scope movement **+8**. Done unchanged — this decision completes no story |

**Story Points are not double-counted.** #110 keeps a single `sp:5`; #127 and #128 carry
`sp:8` each. The +8 is an honest scope correction, not completed work: the original 13 never
contained the delivery-context modelling, so it was never a credible estimate for the outcome
as written.

**What moved.** #110 goes `status:proposed → status:ready` at **5 SP** as `#110a`. #127 and
#128 are created `status:proposed`. V3.3 scope rises **270 → 278** with done unchanged at
**179**. #107, #108, #109 and #123 remain closed; #44, #38, #111, #42, #43, #45, #47, #95 and
#99 are untouched.

**No new ADR.** ADR-049 still gates the family; §6 receives only a dated amendment note —
28 insertions, zero deletions, committed alone per the ADR's own rule — so §6.1–§6.7 stand
exactly as ratified. No ADR-050 was created and no #110 implementation began with this change.

## V3.3 Story #127 split and re-estimated, 2026-09-10

`V33-DEC-035` split #127 (`#110c`) after a read-only readiness audit against
`0bfdbe3c0c4c0c7d50bff809a7e67bce52c8b1ae` found its two halves in different states.
**Structure and contract only** — no commercial value, no Legal wording, no schema, no new
ADR and no implementation.

**Why.** `V33-DEC-034` R8 gave `#110c` a *direction* and no authorization. The audit found
the **location** half resolvable but sitting across two authorities that do not intersect
today: a slot can be created only by the professional whose session it is
(`POST /v1/me/availability/slots` — the id comes from the token, and there is no path
parameter and no ownership resolver), and **no route anywhere lets a business owner create
or edit a slot**, while locations and resources are owner-only under `V33-DEC-034` R3. The
cardinalities come from constraints rather than data: one professional profile per user, at
most one **active** business affiliation per professional, **0..N** locations per business,
and **no professional→location relation at all**. The **resource** half was blocked
outright: `provider.services` carries no kind, no resource and no location, so nothing could
stop a haircut receiving a laser device.

**What was ruled.** **R1** splits the story. **R2** puts the authoritative location on the
consented membership (`business_staff.location_id`, owner-managed and audited), and business
ownership alone never silently binds a professional to a location. **R3** adds an immutable
`availability_slots.delivery_location_id` snapshot, written once through a booking-declared
port and frozen once the slot leaves `open`, so a rebinding affects **future slots only** and
a reschedule uses the **new** slot's snapshot. **R4** limits a membership to one location and
records a simultaneously multi-branch practitioner as an explicit MVP limitation with its own
future decision. **R5** selects **Option A** for eligibility — a business-owned mapping
holding an opaque provider service id and one required kind — rejecting a `provider.services`
column, a per-slot pinned resource and outright deferral. **R6** closes the requirement
semantics. **R7** leaves selection itself to #128. **R8** keeps `resourceRef` owner-bound and
byte-identical. **R9** forbids every customer-facing disclosure. **R10** sets the issue states
and requires `#127b` to receive **its own** readiness audit before becoming Ready.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #127 (`#127a`) | 8 | **5** | Delivery-location context: a nullable owner-managed `business_staff.location_id`, a nullable immutable `availability_slots.delivery_location_id` snapshot written through a booking-declared port, standalone-professional compatibility, no backfill, and the reschedule and freeze semantics. **Ready** |
| #131 (`#127b`) | — | **8** | Service resource requirement and eligible-resource resolution: a business-owned `service_resource_requirements` mapping binding an opaque provider `service_id` to exactly one required kind from `room \| device \| station`, with no cross-schema FK and no `provider` ORM import. `status:proposed` pending its own readiness audit |
| **Total** | **8** | **13** | Net V3.3 scope movement **+5**. Done unchanged — this decision completes no story |

**Story Points are not double-counted.** #127 keeps a single `sp:5`; #131 carries `sp:8`. The
+5 is an honest scope correction, not completed work: the original 8 silently contained the
unresolved resource-eligibility model.

**What moved.** #127 goes `status:proposed → status:ready` at **5 SP** as `#127a`. #131 is
created `status:proposed`. **#128 now depends on both** and takes its byte-identity baseline
from the **post-`#127a`** slot schema. V3.3 scope rises **278 → 283** with done unchanged at
**184**. #110, #109, #108, #107 and #123 remain closed; #44, #38, #111, #42, #43, #45, #47,
#95 and #99 are untouched.

**No new ADR.** ADR-049 still gates the family; §6 receives only a dated amendment note —
44 insertions, zero deletions, committed alone per the ADR's own rule — so §6.1–§6.7 and the
2026-09-09 note stand exactly as ratified. No ADR-050 was created and no #127 implementation
began with this change.

## V3.3 Stories #127 (`#127a`) and #131 (`#127b`) delivered, 2026-09-10

Both children of the 2026-09-10 split above have since shipped, each after its own fresh
preflight against the then-current `master` per the split's own implementation gate. This
entry recomputes the dashboard to reflect both; neither is a further scope decision.

**#127 (`#127a`), 5 Story Points.** Delivery-location context. `business.business_staff`
gained a nullable, owner-managed `location_id` with a composite same-business FK; the
professional/staff-managed statuses and every other actor remain refused from writing it.
`booking.availability_slots` gained a nullable, opaque `delivery_location_id` snapshot,
written once through a booking-declared `DELIVERY_LOCATION_DIRECTORY` port and frozen by
trigger once the slot leaves `open`. A standalone professional and a professional whose
membership carries no branch keep NULL and behave exactly as before; no backfill invents a
location. Merged to `master` as commit `4f7cc98` (PR #133).

**#131 (`#127b`), 8 Story Points.** Service resource requirement and eligible-resource
resolution. `business.service_resource_requirements` binds an opaque `provider.services` id
to exactly one required `room | device | station` kind, with a named CHECK, a named
`UNIQUE (business_id, service_id)` index, no cross-schema FK and no `provider` ORM import in
`business`. Two composition-root ports in opposite directions —
`SERVICE_OWNERSHIP_DIRECTORY` (business → provider) and `ELIGIBLE_RESOURCE_DIRECTORY`
(booking → business) — neither wired into any existing booking path: a NULL service id, a
NULL delivery location, or a service with no requirement all resolve to no candidates,
byte-identical to the pre-#131 path. Owner-only admin routes, transactional audit, and an
ADR-027 `retained` disposition pinned by an explicit test. #131's own read-only readiness
audit (2026-09-10) found it READY AFTER BODY CORRECTION; the body was corrected on four
points (nullable-service semantics, the two ports' exact directions, an explicit ban on a new
`*-contract` package and on versioning, and the stale `bookable_resources` table name) before
implementation began. Merged to `master` as commit `b7056b0` (PR #134), closing #131.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #127 (`#127a`) | `status:ready`, 5 | **Closed, 5** | Delivered as described above |
| #131 (`#127b`) | `status:proposed`, 8 | **Closed, 8** | Delivered as described above |
| **Total** | **13** | **13** | Net V3.3 scope movement **0** — both points already counted at the 2026-09-10 split. Done rises by **13** |

**What moved.** Both issues close with `sp:5`/`sp:8` preserved and no status label. V3.3 done
rises **184 → 197**; V3.3 scope stays **283**. **#128 (`#110b`) is unchanged** —
`status:proposed`, `sp:8` — its two prerequisites are now both satisfied, but backlog policy
does not mechanically move a story to Ready on a dependency closing, so #128 stays exactly as
the 2026-09-10 split left it pending its own fresh preflight and readiness work. #111, #42,
#43, #45, #47, #95 and #99 remain untouched.

**No new ADR and no new decision card.** Neither delivery reopened ADR-049 §6 beyond the
amendment notes already recorded at the 2026-09-09 and 2026-09-10 splits, and neither required
a product decision — R5–R9 of `V33-DEC-035` already settled every product-shaped question for
#131, and #127a's contract was already ratified in full by the same card.

## V3.3 Story #128 (`#110b`) delivered, 2026-09-10

The last child of the `V33-DEC-034`/`V33-DEC-035` resource-assignment lineage has shipped,
after its own fresh preflight against the then-current `master` (post-`#127a`/`#131`, commit
`b1f0eef`). This closes the lineage started by `V33-DEC-034` in full: `#110a` (#110), `#127a`
(#127), `#127b` (#131) and now `#110b` (#128) are all complete.

**#128 (`#110b`), 8 Story Points.** Booking resource assignment and collision prevention. One
new table, `booking.booking_resource_assignments` — one row per booking (mutated in place
across reschedule, the same pattern `booking.bookings` itself already follows), an opaque
`resource_id` with no cross-schema FK, and a partial GiST exclusion constraint over
`(resource_id, [start_at, end_at))` for `status = 'active'` rows that PostgreSQL itself
enforces. Assignment is wired into the existing booking-creation, cancellation and reschedule
transactions, never a separate write: creation locks and re-verifies each eligible candidate
in a fixed ascending-id order, one at a time, attempting the write under its own `SAVEPOINT`
so a collision moves on to the next candidate instead of aborting the surrounding transaction;
exhausting every candidate refuses with the platform's existing generic
`SlotUnavailableException`, never a 500. A `NULL` service, a service with no configured
requirement, or a `NULL` delivery location all book exactly as they did before #128, with no
assignment attempted. Cancellation releases the assignment atomically; reschedule re-resolves
the destination from scratch and never carries the old resource forward, leaving the original
booking and assignment completely untouched if the destination can't be served.

`business`'s resource retirement and location closure now refuse (generically) while a future
active assignment exists, through a new `ResourceAssignmentDirectoryPort` — the mirror image
of `#131`'s own `ELIGIBLE_RESOURCE_DIRECTORY` — so neither module ever reads the other's
tables directly; both sides of that race close through one shared advisory lock keyed by
resource id, the same convention `#131` established for the opposite direction.
`ELIGIBLE_RESOURCE_DIRECTORY.eligibleResourcesFor` gained the `null`-vs-`[]` distinction
`#131`'s own documentation had already flagged as needed — `null` for "no resolvable
requirement, proceed without assignment," `[]` for "a requirement exists but nothing is
eligible, refuse" — a contract refinement, not a behaviour change, for every `#131` caller.
The new table is `subject_data` by explicit owner direction (pinned by a dedicated test, since
the repository's own coverage heuristic cannot infer it from the column names), exported
scoped to the subject's own bookings with the resource id withheld, and retained — never
deleted — on erasure, matching `booking.bookings` itself. `booking.availability_slots` keeps
its ratified `no_subject_data` disposition unchanged. Merged to `master` as commit `b7b29e6`
(PR #137), closing #128.

| Item | Before | After | Outcome it owns |
|---|---:|---:|---|
| #128 (`#110b`) | `status:proposed`, 8 | **Closed, 8** | Delivered as described above |

**What moved.** #128 closes with `sp:8` preserved and no status label. V3.3 done rises
**197 → 205**; V3.3 scope stays **283** — the point was already counted at the 2026-09-09
split. This closes the entire `V33-DEC-034`/`V33-DEC-035` lineage: #110 (`#110a`), #127
(`#127a`), #131 (`#127b`) and #128 (`#110b`) are now all closed. Epic #44 stays **open** —
#111 (`#44e`, 8 SP) remains `status:proposed` and un-decomposed, so #44 cannot close
structurally. #42, #43, #45, #47, #95 and #99 remain untouched.

**No new ADR and no new decision card.** #128's own fresh preflight found every engineering
question already delegated to ADR-049 (§6 and its amendment notes) or resolvable by existing
repository convention — the `null`-vs-`[]` port refinement, the SAVEPOINT-per-candidate retry,
and the `subject_data` claim (matching `booking.bookings`'s own retained-on-erasure pattern
despite ADR-049 §7.2's literal `retained` label for this row, which describes the same
behavioural outcome under a different disposition name) — with no genuine unresolved
product, legal or security choice requiring a new decision card.
