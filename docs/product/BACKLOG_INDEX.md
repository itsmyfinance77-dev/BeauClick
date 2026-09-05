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
| V3.3 | Product Maturity Programme | Active foundation: #39, #40 (`#40a`), #56 (`#56a`), #69 (`#56b`), #72 and #75 complete; epic #38 in progress; Story #41 decomposed by `V33-DEC-022` into #41 (`#41a`), #81 (`#41b`), #82 (`#41c`) and #83 (`#41d`) and re-estimated 13 -> 37; #57, #58 and the whole #41 family not started | No tag authorized | Real money blocked by #47; unresolved values/copy blocked by #46 |
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
| #57 (`#40c`) | — | 5 | Custom booking-credit purchase and immutable price snapshots. Depends on #40. No gateway or recurring billing. |
| #58 (`#40d`) | — | 8 | Atomic consumption at first `confirmed` and idempotent return. Depends on #56, #57 and the zero-collectible confirmation path, which `V33-DEC-022` moved into #81 (`#41b`) together with the mandatory transaction seam this story hooks. |
| **Total** | **13** | **37** | Net V3.3 scope movement **+24**. |

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
| #81 (`#41b`) | — | 8 | Zero-collectible confirmation orchestrator with no public confirm route and no fabricated intent, attempt, event or receivable, plus the **mandatory** composition seam #58 hooks. Gated on the zero-collectible order-status/event ruling. |
| #82 (`#41c`) | — | 8 | Sandbox deposit execution; intent amount becomes the platform collectible; refund ceiling and financial projection limited to collected money. Gated on the `OrderPaid` meaning of a partial capture. |
| #83 (`#41d`) | — | 13 | Database-backed administrator publication and selection of versioned collection policy, fail-closed. Blocked by `V33-DEC-011`, `V33-DEC-012`, the percentage calculation base and `V33-DEC-017`. |
| **Total** | **13** | **37** | Delivery order #41 -> #81 -> #82 -> #83. |

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
