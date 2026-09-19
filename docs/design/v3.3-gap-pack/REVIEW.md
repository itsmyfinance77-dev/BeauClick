# Reviewer acceptance — V3.3 design-gap pack

**Reviewed 2026-09-20 by the BeauClick PM session, against `master` = `694d037`.**
Delivered by Claude Design on 2026-09-19 from the brief `docs/design/V3.3_DESIGN_GAP_AND_HANDOFF.md`
(the copy it worked from is byte-identical to master's).

**Verdict: accepted, with three corrections and one blocking backend dependency.**

## What was checked, and how

Not read for plausibility — each factual claim was matched against the code it describes:

| Claim | Checked against | Result |
|---|---|---|
| Twelve funds field names | `toFundsResponse` in `financial.controller.ts` | **Exact**, all twelve |
| 22 admin outcome-policy routes | route decorators in `booking-outcome-policy.controller.ts` | **Exactly 22** |
| 9 admin commission-policy routes | `commission-policy.controller.ts` | **Exactly 9** |
| Three commission components | `COMMISSION_COMPONENTS` | **Exact**, and in the binding order |
| Four closed shapes, bp ceiling 10000 | `COMMISSION_RULE_KINDS`, `MAX_COMMISSION_BASIS_POINTS` | **Exact** |
| Two bases, neither defaulted | `COMMISSION_BASES`, the column's absent DEFAULT | **Exact** |
| Seller assignment routes | `SellerOutcomePoliciesController`, `OutcomePolicyAssignmentController` | **Exact** |
| Statement bound 1–2000 | `MarkNoShowDto`, `ck_nsd_statement_length` | **Exact**, but see C2 |
| Remedy default and override window | `CustomerRemedyResolutionService` | **Accurate** |
| Screen numbers 47–50 unclaimed | canonical tree `00`–`46` | **Free** (43 is also unassigned) |
| No invented value | grep of all five prototypes | **Clean**; no `7`, no rate, no cap; 46 `SAMPLE` labels |
| Self-contained | external URL scan | **Clean**; no external reference in any prototype |

## Corrections, recorded in the specs themselves

**C1 — screen 46, the boundary has three sides.** `collected`, `platformAdvance` and `recoveredIn`
are custody and cash-position facts (ADR-052 §12's M1), **not** this workspace's money. Shown
inside the seller group they read as money owed, which is the exact misreading the amendment's own
"no total" rule exists to prevent. Three bounded blocks, not two.

**C2 — screen 49, the no-show statement is required for a governed booking.** Optional at the DTO
only so an ungoverned pre-`#42d` booking keeps its body-less route; `markNoShow` throws
`NoShowStatementRequiredException` on an empty one. The spec's "no asterisk, no hint that leaving
it blank costs the seller anything" would ship a form the server refuses on the commonest path.
The privacy intent behind that sentence survives intact — no photo, no location, no health field,
nothing implying a longer statement helps.

**C3 — screen 48, there is one required free-text field.** `AssignOutcomePolicyDto.reason` is
non-optional and length-bounded, and a boundary spec pins it. "No free-text field on this screen"
is true of the selection and false of the submission.

## The blocking dependency

**Screen 49 cannot be implemented against today's API.** `POST …/no-show` and `POST …/remedy` are
the only routes in the family; nothing reads back a declaration, a grace snapshot, an objection
window, a remedy resolution or a refund execution status, and `toBookingShape` carries none of
them. Eight of screen 49's twelve states need facts the server does not return.

This is a **backend gap, not a design defect**: the design refused to compute the permitted instant
client-side, which is correct under ADR-051, and that refusal is what makes the gap visible. A read
route must be specified and built first.

**Screens 46, 47, 48 and 50 are implementable today.**

## The manifest's three open items, answered

1. **Numbering 47–50** — confirmed free. Keep them. (`43` is an unassigned gap in the canonical
   sequence and stays one.)
2. **Persian terminology for the twelve fund states** — ratified as **provisional**, to be revisited
   at the first seller-facing copy review rather than blocking implementation. C1 changes which
   heading three of the terms sit under, not the terms themselves.
3. **Customer-facing wording in §B3** — accepted as illustrative structure. The copy family on
   screen 47 owns the real text, exactly as the manifest states.

## Not delivered, correctly

Dispute and appeal (`#42e`/#162), completed-booking objection (`#42f`/#180) — `gate:legal`, backend
not built. Settlement execution, provider fees, paid credit activation — `gate:external`. The
commission snapshot (`#43b-2`) has no surface by design. The seller-facing commission disclosure is
a separate, unratified surface.
