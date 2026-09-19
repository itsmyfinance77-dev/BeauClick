# Screen 50 — Admin commission policy publication (`#43b-1` / #173)

**Binding:** ADR-052 §1. Consistent with `40_ADMIN_COMMERCIAL_CATALOGUE`.
**Routes:** `/api/v1/admin/commercial/commission-policies…` — 9 routes, capability
`bc_manage_commercial_plans`. Merged 2026-09-19.
**Prototype:** `Prototype - Admin Commission Policy.dc.html` (§D1–D5).
**Backend:** implemented and merged. **Frontend: designed, not implemented.**

The platform has **no commission number in its code**: the rate is whatever an administrator
publishes here. This relates to the long-standing C-5 finding (the legacy `DEFAULT_COMMISSION_RATE_BP`
constant) only as its replacement path; no figure from it appears in this design.

## 1. Three components, one key each

Booking commission (کارمزدِ نوبت), acquisition (جذبِ مشتری), processing recovery
(بازیافتِ هزینهٔ پرداخت). Each is shown as its own card carrying its currently effective rule, or
stating plainly that none is published.

## 2. Four closed shapes — the shape decides the fields

| Shape | Fields that exist |
|---|---|
| **zero** | none — no rate, no amount, no base |
| **percentage** | a rate in basis points (0–10000) **and** a base |
| **fixed** | a flat Toman amount strictly above zero. **No base** |
| **hybrid** | a flat amount (may be zero) **plus** a rate **and** a base |

The editor is shape-aware: changing the shape changes which fields exist. Fields that do not belong
to the current shape are **absent**, never disabled or greyed. The four shapes are the only
reachable states of the form.

**zero is a published decision** and is not the same thing as no policy at all. Its card says
"nothing is charged" and carries its version and effective instant like any other rule.

## 3. The base is never defaulted

The base is either **the amount the platform actually collected** or **the service total**. They
differ by exactly what the customer has not paid yet, so the choice is consequential: neither option
is pre-selected, neither is pre-filled, and display order carries no recommendation. The two options
are described in one line each so the difference is readable without outside knowledge.

## 4. Lifecycle constraints

- `draft → published → retired`, one way. A published rule is immutable; publish a new version
  instead. No edit affordance on a published row.
- Two versions of one component can never be effective at once; a publication that would overlap is
  refused, and the refusal leaves the draft and the typed reason intact.
- The publication instant is the server's, to the microsecond. No date picker, no retroactive
  publication, no scheduling.
- Every mutation requires a stated reason.
- Nothing is seeded: all three components unpublished is a normal state on a fresh platform — no
  warning icon, no "0 of 3" progress, no language implying an incident.

## 5. Boundary of this surface

Administrator-only. What a **seller** is eventually told about commission is a separate, unratified
surface and is not designed here: no seller preview, no worked example against a real order, no
statement of when or how a seller is informed.

## 6. States

| # | State | Where |
|---|---|---|
| 1 | Three components at a glance, effective rule each | §D1 |
| 2 | zero as a published decision | §D1 |
| 3 | Component with nothing published | §D1 |
| 4 | Version timeline per component | §D2 |
| 5 | Shape-aware editor — zero | §D3 |
| 6 | Shape-aware editor — percentage (rate + base) | §D3 |
| 7 | Shape-aware editor — fixed (amount, no base) | §D3 |
| 8 | Shape-aware editor — hybrid (amount + rate + base) | §D3 |
| 9 | Publish confirmation with frozen-terms summary and required reason | §D4 |
| 10 | Refusal — overlapping effective rule | §D4 |
| 11 | Retire confirmation, and the resulting no-effective-rule statement | §D4 |
| 12 | All three unpublished | §D5 |
| 13 | Loading | §D5 |
| 14 | Read failure with retry, never rendered like "unpublished" | §D5 |
| 15 | Mobile 390 | §D5 |

## 7. Values

Every rate, amount and date in the prototype is labelled **SAMPLE**. No rate is proposed,
recommended or carried over from any existing constant.

## 8. Accessibility

`<fieldset>`/`<legend>` for shape and base with native radios; real `<table>` with `<thead>` for the
timeline; lifecycle state by text and shape; `role="dialog"`/`aria-modal` on the publish dialog;
`role="alert"` on refusals; ≥44px targets; tabular numerals; `dir="ltr"` isolation on `bp`, routes
and Latin identifiers.

Requires testing at implementation: focus management when the shape change adds or removes fields,
live announcement of the new field set, focus return from the dialog, screen-reader RTL order,
measured contrast, real-device target size. **No WCAG 2.1 AA conformance is claimed.**
