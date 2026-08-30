# BeauClick Product Backlog Index

The live backlog is maintained in GitHub Issues. This file records the programme
structure and prevents phase names from drifting between the roadmap, milestones,
and issue labels.

## Live views

- [Backlog Dashboard](https://github.com/marabi766/BeauClick/issues/2)
- [V3.2-C full backlog](https://github.com/marabi766/BeauClick/issues?q=is%3Aissue+milestone%3AV3.2-C)
- [Decisions awaiting closure](https://github.com/marabi766/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Adecision)
- [Ready work](https://github.com/marabi766/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready)
- [Work in progress](https://github.com/marabi766/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ain-progress)
- [Blocked work](https://github.com/marabi766/BeauClick/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ablocked)

A GitHub Project may provide additional visual views later, but it is never the
source of truth. Issues, labels, milestones, and the generated dashboard remain
authoritative so progress measurement does not depend on a particular UI or
account-level Project permission.

| Milestone | Outcome | Delivery status at system adoption |
|---|---|---|
| V3.2-C | Referral and Wishlist | Next; refinement required — see the reconciliation note below |
| V3.2-D | Professional CRM and Delegation | Planned; product decisions required |
| V3.2-E | B2B Quotes and Campaigns | Owner-gated; payment gate applies to settlement |
| V3.2-F | Payout and Calendar Automation | Predominantly external-gated |
| V3.2-G | Evidence-Gated Scale | No commitment without evidence |
| V3.3 | Product Maturity Programme | Future programme |
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
