# V3.3 design-gap pack — prompts A–E

Compiled 2026-09-19 against the gap brief `V3.3_DESIGN_GAP_AND_HANDOFF.md`
(`master` = `8db3ed8`, design branch `design/claude-design` = `cc9371d`).
Reviewer: the BeauClick PM session. **Importable as one folder.**

Every surface here had merged, tested backend and zero design coverage. Nothing in the existing
snapshot was modified; screen 46 is amended by a separate amendment file rather than rewritten.

## Contents

| File | Prompt | Covers |
|---|---|---|
| `Prototype - Finance Funds States.dc.html` | E | Twelve per-state funds as an added section of screen 46 |
| `Prototype - No-show and Remedy.dc.html` | C | Seller no-show declaration; customer remedy |
| `Prototype - Seller Outcome Policy.dc.html` | B | Seller selection inside published sets |
| `Prototype - Admin Outcome Policy.dc.html` | A | Outcome policy versions, customer copy, evidence register |
| `Prototype - Admin Commission Policy.dc.html` | D | Three components, four closed shapes |
| `docs/design/screens/46_FINANCE_WORKSPACE_AMENDMENT.md` | E | Amendment to the existing screen 46 |
| `docs/design/screens/47_ADMIN_OUTCOME_POLICY.md` | A | New screen spec |
| `docs/design/screens/48_SELLER_OUTCOME_POLICY.md` | B | New screen spec |
| `docs/design/screens/49_BOOKING_NO_SHOW_AND_REMEDY.md` | C | New screen spec |
| `docs/design/screens/50_ADMIN_COMMISSION_POLICY.md` | D | New screen spec |
| `support.js`, `fonts/` | — | Runtime and self-hosted Vazirmatn / Anjoman / Peyda, copied from the snapshot |

Screen numbers 47–50 continue the existing `00`–`46` sequence. Rename on import if the canonical
tree has already claimed them.

## Rules held across all five

- **No default the server will not supply.** No settlement cadence, no "7 working days", no payout
  minimum, no reserve percentage, no inferred risk class, no pre-filled cutoff, grace, rate or base.
- **Publication is immediate.** `published_at` is the transaction clock; there is no scheduling UI,
  no date picker for an activation instant, no retroactive publication anywhere.
- **Immutability is shown, not implied.** A published version carries no edit affordance — not even
  a disabled one. Changing a live rule means publishing a new version.
- **Every mutation carries a stated reason**, on both publish and retire.
- **Nothing is seeded.** Empty is a first-class, legitimately correct state on a fresh platform, and
  is never rendered like a read failure.
- **Exactly one customer-copy version is active platform-wide** — rendered as a single card, never
  a list.
- **No figure crosses the seller/platform boundary** in the finance amendment; no total is invented.
- Persian `fa-IR` RTL copy throughout, with English annotations in the specs and field names shown
  `dir="ltr"`.
- **Every example value is labelled SAMPLE.** No rate, price, allowance, cutoff, retention or cap is
  proposed.
- Visual language, section-badge structure, design-review annotation frames, ≥44px targets and
  state-by-text-and-shape follow `Prototype - Finance Workspace.dc.html` and
  `Prototype - Admin Control Plane.dc.html`.

## Covered states

Empty / nothing published · refusal on overlap · refusal on non-qualifying evidence · fail-closed
after a narrowed range · second visit / already-resolved · all-zero funds · loading · read failure
with retry (never offered on a refusal) · mobile 390.

## Out of scope, deliberately

Dispute and appeal (`#42e`/#162) and completed-booking objection (`#42f`/#180) — backend not built,
`gate:legal`. Settlement execution, provider fees, paid credit activation (`#43e`, `#43g`, #99, #47)
— `gate:external`. The commission snapshot (`#43b-2`/#192) — no surface by design. The seller-facing
commission disclosure — separate and unratified.

## Open items for the reviewer

1. Screen numbering 47–50 needs confirming against the canonical tree.
2. Persian terminology for the twelve fund states is proposed here for the first time; it should be
   ratified before implementation, since the same words will appear in seller-facing copy.
3. The customer-facing wording shown in the seller confirmation (§B3) is illustrative structure, not
   approved legal copy — the copy family in screen 47 owns the real text.
