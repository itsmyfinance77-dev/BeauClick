# Screen 48 — Seller outcome-policy selection (`#42b` / #159)

**Binding:** ADR-051 §3. Consistent with `42_SELLER_COMMERCIAL_AND_OPERATIONS`.
**Prototype:** `Prototype - Seller Outcome Policy.dc.html` (§B1–B6).
**Backend:** implemented and merged. **Frontend: designed, not implemented.**

## 1. What the seller does, and does not, do

The seller does not write policy. The administrator publishes allowed **ranges and sets**
(screen 47); the seller picks **one member of each**, per workspace.

| Route | Use |
|---|---|
| `GET /api/v1/me/outcome-policies` | What this seller may choose |
| `GET /api/v1/me/outcome-policy-assignments/:workspaceRef` | The current selection |
| `PUT /api/v1/me/outcome-policy-assignments/:workspaceRef` | Replace it |

## 2. Workspace first, always explicitly

A seller may own several workspaces (a professional profile and a business). Every workspace is
addressed by an **opaque `workspaceRef`** — never displayed, decoded, shortened or typed. Names come
from the server.

**No workspace is ever pre-selected**, not even when there is one, and not from the previous
session. Until a workspace is chosen, no policy is rendered. Each card states whether that workspace
already has a current selection.

## 3. The selection is a pick inside a published set

Every group renders exactly the published members and nothing else. **There is no free-text or
numeric field on this screen** — a percentage or a Toman amount that appears as a choice is itself a
published member, not an input.

Groups the seller chooses from: cancellation cutoff, late-cancellation retention, no-show grace,
no-show retention.

Terms the seller does **not** choose are shown as published and unselectable: free-reschedule count,
dispute window, bodily-harm window, appeal window, legal cap. If a term was not published, no row
for it exists — the UI never defaults one.

## 4. Superseded, never edited

Choosing again creates a new current selection; the previous becomes history. Bookings already taken
**keep the terms they were taken under**, and the confirmation says so.

The confirmation also shows, verbatim in shape, what the customer will be told as a result of this
selection, so the seller sees the consequence before committing.

History is a read-only table, newest first, with current versus superseded distinguished by **text
and shape** (filled circle / hollow square), never colour alone. No row is editable or removable.

## 5. Fail-closed, and not-enrolled

**Fail-closed.** If the administrator republishes a narrower range that no longer contains this
workspace's member, **new bookings are refused until the seller selects again**. This is a real,
reachable screen: it states the fact, states that existing bookings are untouched, and offers the
selection. It is not an error page and carries no blame.

**Not enrolled.** A seller with no selection is on the legacy path and is not broken. One plain
sentence says bookings continue as before. No warning icon, no "incomplete setup", no badge.

## 6. States

| # | State | Where |
|---|---|---|
| 1 | Workspace chooser, nothing pre-selected | §B1 |
| 2 | Workspace with an existing selection | §B1 |
| 3 | Workspace with no selection yet | §B1 |
| 4 | Selection screen, allowed members only | §B2 |
| 5 | Non-selectable published terms | §B2 |
| 6 | Confirmation showing the customer-facing consequence | §B3 |
| 7 | History of superseded selections | §B4 |
| 8 | Fail-closed after a narrowed range | §B5 |
| 9 | Not enrolled — legacy path | §B5 |
| 10 | Nothing published to choose from | §B5 |
| 11 | Loading | §B5 |
| 12 | Read failure with retry | §B5 |
| 13 | Mobile 390, two-step selection | §B6 |

## 7. Accessibility

`<fieldset>`/`<legend>` per group with native radios, so keyboard selection never depends on visual
order; ≥44px targets; `role="alert"` on the fail-closed notice; real `<table>` with `<caption>` for
history; state by text and shape; `dir="ltr"` isolation on Latin runs.

Requires testing at implementation: focus return after the confirmation dialog, live announcement of
a saved selection, screen-reader RTL order within each group, real-device target size.
**No WCAG 2.1 AA conformance is claimed.**

---

## Reviewer corrections — 2026-09-20 (BeauClick PM session)

**R1 — §3 is wrong: there IS one required free-text field.** `AssignOutcomePolicyDto` carries
`reason!: string`, non-optional, bounded by `OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH` and
`…_MAX_LENGTH`, and `story-159-boundary.spec.ts` pins the field list as exactly
`['policyKey', 'cutoffHours', 'lateCancellationRetention', 'noShowGraceMinutes', 'noShowRetention',
'reason']`. A PUT without it is refused. §3's sentence "There is no free-text or numeric field on
this screen" holds for the **selection**, and must not be read as holding for the **submission**:
the confirmation dialog of §B3 needs a required, length-bounded reason field with its bounds
surfaced before submit. The rest of §3 stands — every policy term is still a pick inside a
published set, never typed.

**R2 — the PUT is capability-gated**, on the existing `bc_manage_own_collection_policy`, granted to
`professional` and `business` only. A seller session without it reads the screen and cannot submit.
Not designed; needs a read-only variant of §B2 or the route hidden.

**R3 — `PUT` is idempotent on the same key and members**, so re-submitting an unchanged selection is
not an error and must not render as one.
