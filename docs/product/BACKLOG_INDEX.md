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

| Milestone | Outcome | Delivery status at system adoption |
|---|---|---|
| V3.2-C | Referral and Wishlist | **Complete 2026-09-02 — 59/59 Story Points** |
| V3.2-D | Professional CRM and Delegation | Planned; product decisions required |
| V3.2-E | B2B Quotes and Campaigns | Owner-gated; payment gate applies to settlement |
| V3.2-F | Payout and Calendar Automation | Predominantly external-gated |
| V3.2-G | Evidence-Gated Scale | No commitment without evidence |
| V3.3 | Product Maturity Programme | Active foundation: #39 complete; epic #38 in progress; Story #40 decomposed 2026-09-02 |
| V3.4 | Conditional Expansion Programme | Written owner decision and evidence required |

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
| #56 (`#40b`) | — | 8 | Seller subscription lifecycle and plan-included grants. Depends on #40. No payment collection. |
| #57 (`#40c`) | — | 5 | Custom booking-credit purchase and immutable price snapshots. Depends on #40. No gateway or recurring billing. |
| #58 (`#40d`) | — | 8 | Atomic consumption at first `confirmed` and idempotent return. Depends on #56, #57 and Story #41's zero-online-collection confirmation path. |
| **Total** | **13** | **29** | Net V3.3 scope movement **+16**. |

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
