# Screen 49 — No-show declaration and customer remedy (`#42d` / #161)

**Binding:** ADR-051 §7–§8.
**Prototype:** `Prototype - No-show and Remedy.dc.html` (§C1–C6).
**Backend:** implemented and merged. **Frontend: designed, not implemented.**

Two connected moments in one booking. They share a record and nothing else: the seller's declaration
is an evidence-minimal fact; the customer's remedy is a resolution that is already in effect.

## 1. Seller — declaration

`POST /api/v1/bookings/:id/no-show`. Permitted only after **slot start + the grace minutes the
booking's own terms carry**, and only for a confirmed booking. Payload: nothing required; an
optional `statement` of at most 2000 characters.

- **Before the permitted instant** the entry point is not a disabled button. A sentence stands in
  its place: the declaration becomes possible once this booking's grace period has passed. **No
  countdown** is rendered — the permitted instant is the server's, and the client does not compute
  it.
- **The grace value is never invented.** It comes from the terms the booking was taken under. If the
  UI cannot state it, it says nothing rather than defaulting.
- The confirmation dialog states, in two columns, what the declaration **does** (creates one
  permanent record — one actor, one instant; opens the customer's objection window) and what it
  **does not** (moves no money, cancels no refund, cannot be withdrawn).
- The statement field is optional and the UI does not push for one: no asterisk, no "explain for
  faster review", no completeness meter, no hint that leaving it blank costs the seller anything.
  Evidence minimality is a deliberate privacy property.
- **No photo, no location, no health field** anywhere — the API rejects them and the design offers
  no affordance for them.

## 2. Customer — notification

One notification, worded around the fact and the next step. It carries **no amount**, because the
declaration determined none. The seller's statement, if any, appears on the booking screen, not in
the notification.

## 3. Customer — remedy

`POST /api/v1/bookings/:id/remedy`, reachable after a cancellation that was not the customer's.
Exactly one remedy is offered and it is **already resolved to the default: a full refund**.

- The screen states that the refund is in progress and that doing nothing loses the customer
  nothing. The default is not a suggestion awaiting confirmation.
- The only override is a **free reschedule**, available while the refund is still pending. The
  override window is bounded by the refund's own state, **not** by a client-side timer. While the
  control is present the override is possible; when it is absent it is not. No countdown appears.
- **The second visit is designed, not only the first.** Once the refund has executed, the screen
  shows the closed resolution — the executed refund and its amount, or the chosen reschedule — with
  a plain sentence that nothing remains to do. A repeat request is a no-op returning the same
  resolution, so it renders as this same screen: no error, no "already done" reprimand, no disabled
  button left behind.

## 4. States

| # | State | Where |
|---|---|---|
| 1 | Declaration permitted | §C1 |
| 2 | Too early — sentence in place of the control | §C1 |
| 3 | Declaration confirmation, does / does not | §C2 |
| 4 | Optional statement, 2000-character bound | §C2 |
| 5 | Customer notification | §C3 |
| 6 | Remedy with the default already applied | §C4 |
| 7 | Reschedule override available | §C4 |
| 8 | Closed — refund executed | §C5 |
| 9 | Closed — reschedule chosen | §C5 |
| 10 | Loading remedy state | §C5 |
| 11 | Read failure with retry (refund unaffected) | §C5 |
| 12 | Mobile 390, both sides | §C6 |

## 5. Not designed here

Dispute and appeal (`#42e`/#162) and the completed-booking objection (`#42f`/#180) — backend not
built, both `gate:legal`. No entry point to either is implied anywhere on these screens.

## 6. Accessibility

`role="status"` on the too-early notice, `role="alert"` on failures, ≥44px targets throughout,
`role="dialog"`/`aria-modal` with a labelled heading on the confirmation, character counter
associated with the textarea, amounts in tabular numerals with `dir="ltr"` isolation on Latin runs.

Requires testing at implementation: focus trap and focus return in the confirmation dialog, live
announcement of the declaration result, screen-reader reading order of the does/does-not columns,
real-device target size, reduced-motion. **No WCAG 2.1 AA conformance is claimed.**

---

## Reviewer corrections — 2026-09-20 (BeauClick PM session)

This screen has the two most serious findings in the pack. The remedy half (§3) is **accurate** —
verified against `CustomerRemedyResolutionService`: the refund default is already applied
server-side, a `refund` POST and every repeat are answered from the locked row without writing, and
`reschedule` is offered only while the refund's execution status is `pending` or `manual_required`.
The declaration half needs two corrections, and the screen as a whole has one blocking dependency.

**R1 — §1 is wrong: the statement is REQUIRED for a governed booking.** `MarkNoShowDto` makes
`statement` optional at the HTTP boundary **only** so that an ungoverned, pre-`#42d` booking keeps
its old body-less route byte for byte. For a governed booking `BookingService.markNoShow` throws
`NoShowStatementRequiredException` on an empty or whitespace-only statement, before anything is
written. §1's guidance — "optional and the UI does not push for one: no asterisk … no hint that
leaving it blank costs the seller anything" — would ship a form whose primary action is refused by
the server on the commonest path.

The privacy intent behind §1 is right and must survive the fix: evidence minimality still forbids
the photo, location, health and completeness-meter affordances, and nothing may imply that a
*longer* statement helps. The correction is narrow — on a **governed** booking the field is
required and marked so, with the 1–2000 bound stated; on an **ungoverned** one §1 stands unchanged.
Whether the booking is governed is the server's answer, not the client's.

**R2 — no read route exists for anything this screen renders.** `POST /bookings/:id/no-show` and
`POST /bookings/:id/remedy` are the only routes in this family. `toBookingShape` returns
`id, customerId, professionalId, serviceId, slotId, startAt, endAt, status, holdExpiresAt,
rescheduleCount, cancellationReason, createdAt` — no declaration, no grace snapshot, no objection
window, no remedy resolution, no refund execution status. States 1, 2, 6, 7, 8, 9, 10 and 11 of §4
all require facts the API does not currently return, and §1's "too early" state needs an
eligibility answer the client is explicitly forbidden from computing.

**This is a backend gap, not a design defect** — the design correctly refused to invent a
client-side countdown, and that refusal is what makes the gap visible. A read route (or an
extension of the booking projection) must be specified and built before screen 49 can be
implemented. It is the only one of the five surfaces in this pack that is blocked; 46, 47, 48 and
50 are implementable against the API as it stands today.

**R3 — the remedy POST requires an explicit `choice`.** `RemedyChoiceDto.choice` is
`@IsIn(['refund','reschedule'])` and not optional, so "accept the default" is a POST with
`choice: 'refund'`, not an empty body. Consistent with §3's reading; stated because the wire shape
is not obvious from it.
