# Screen 47 — Admin booking-outcome policy publication (`#42a`, issue #42)

**Binding:** ADR-051 §1 and §5. Consistent with `40_ADMIN_COMMERCIAL_CATALOGUE` and
`44_ADMIN_CONTROL_PLANE`.
**Routes:** `/api/v1/admin/commercial/outcome-policies…` — 22 routes, capability
`bc_manage_commercial_plans`.
**Prototype:** `Prototype - Admin Outcome Policy.dc.html` (§A1–A8).
**Backend:** implemented and merged. **Frontend: designed, not implemented.**

This surface publishes **ranges and sets a seller later chooses inside** (screen 48). Nothing
published here binds a booking directly.

## 1. Three families

**1 · Outcome policy versions.** A policy key has versions on a one-way `draft → published →
retired` lifecycle. A version carries: allowed cancellation cutoff hours (a set), allowed
late-cancellation retention options (each `none`, a rate in basis points, a fixed Toman amount, or
"full collected"), allowed no-show grace minutes (a set), allowed no-show retention options (same
shapes), a free-reschedule count before cutoff, a dispute window in hours, a bodily-harm window in
hours, an appeal window in hours, an optional case-file retention in days, and an optional **legal
cap** publishable only against a qualifying Legal-evidence record.

**2 · Customer policy copy.** `fa-IR` text the customer accepts at checkout, same lifecycle.
**Exactly one copy version is active platform-wide at any instant** — so this family renders as a
single active card, never a list of active copies.

**3 · Legal evidence register.** Records with a key, a subject (`retention_cap` or `policy_copy`), a
reference kind, a reference and a summary. One-way lifecycle `recorded → retired`.

## 2. Constraints the design must not contradict

- **Every mutation requires a stated reason.** Publish and retire dialogs both carry a required
  reason field; there is no unexplained change anywhere.
- **A published version's terms are immutable.** "Editing" a live policy means publishing a new
  version. A published row therefore carries **no edit affordance at all** — not even a disabled
  one. Editing exists on drafts only.
- **Two versions of one key can never be effective at the same instant.** Publishing while another
  is live is refused; the timeline never renders overlapping effective windows.
- **The activation instant is the server's.** No date picker, no scheduling, no retroactive
  publication. The publish dialog says the version becomes effective at confirmation.
- **A legal cap without qualifying evidence is refused**, and the refusal names nothing beyond "not
  qualifying". The UI adds no guess (not "expired", not "wrong subject").
- **Nothing is seeded.** On a fresh platform every list here is legitimately empty; the empty state
  is a first-class screen with its own copy, never an error and never confused with a read failure.

## 3. Screens

| # | Screen / state | Where |
|---|---|---|
| 1 | Lifecycle legend, one-way | §A1 |
| 2 | Policy key list with effective version and draft column | §A2 |
| 3 | Empty state — no keys yet | §A2 |
| 4 | Version timeline with effective windows | §A3 |
| 5 | Version editor, draft only, no defaults | §A4 |
| 6 | Set editors (cutoffs, grace) as sets, not values | §A4 |
| 7 | Retention options in their four shapes | §A4 |
| 8 | Legal cap bound to an evidence record | §A4 |
| 9 | Publish confirmation with required reason | §A5 |
| 10 | Refusal — overlapping effective version | §A5 |
| 11 | Refusal — non-qualifying evidence | §A5 |
| 12 | Retire confirmation with required reason | §A5 |
| 13 | Customer copy — single active version | §A6 |
| 14 | Customer copy — empty | §A6 |
| 15 | Evidence register, recorded / retired | §A7 |
| 16 | Evidence register — empty, and its effect on the cap field | §A7 |
| 17 | Loading | §A8 |
| 18 | Read failure with retry, distinct from empty | §A8 |
| 19 | Mobile 390 | §A8 |

## 4. Values

No cutoff, grace, percentage, amount, window, retention period or cap is proposed by the design.
Every example in the prototype is labelled **SAMPLE**; empty fields are shown empty rather than
zeroed. Policy keys shown (`standard-outcome`, `strict-outcome`) are sample identifiers, not a
recommended taxonomy.

## 5. Accessibility

`<fieldset>`/`<legend>` per group; real `<table>` with `<caption>` and `<thead>` for the key list and
evidence register; lifecycle state by text and shape; `role="dialog"`/`aria-modal` with labelled
headings; `role="alert"` on refusals; ≥44px targets including chip remove buttons; `dir="ltr"`
isolation on keys, routes and `bp` units.

Requires testing at implementation: focus trap and focus return in both dialogs, computed accessible
names for row actions, live announcement of a publication result, keyboard operation of the set
editors, screen-reader RTL order, measured contrast, real-device target size.
**No WCAG 2.1 AA conformance is claimed from a static prototype.**
