# V3.3 dashboard pack — #45 multi-workspace commercial and operations dashboard

**Story:** [#45](https://github.com/itsmyfinance77-dev/BeauClick/issues/45) (`sp:13`, `track:design`). **Design only.**
**Audited against:** `master` `2e3da4a43482680db5104c1e78dba48a8d2a18f4` · built on `design/claude-design` `4b5b120f3493b76f0ba4147d0712d1afbaea2293`.
**A sibling pack, not a workspace copy.** The canonical snapshot and `v3.3-gap-pack/` are untouched.

## Read in this order

| File | What it is |
|---|---|
| `docs/design/screens/51_WORKSPACE_SHELL_AND_DASHBOARDS.md` | **The design.** One shell, contexts, workspace switching, ten personas, every money fact, disputes, seven states, responsive, RTL, keyboard, privacy, the gaps rendered as unavailable, and the amendments to existing specs |
| `docs/design/screens/52_MODERATOR_LANDING.md` | The owner-approved moderator landing (recommendation A) and the safe media-inspection states. Implemented by #264 and #265 |
| `PERSONA_CAPABILITY_MATRIX.md` | Persona × capability × workspace, with the isolation assertions implementation tests must prove |
| `ROUTE_CONTRACT_MATRIX.md` | Every route the design reads: method, path, authority, handler `file:line`, and the exact fields rendered. Generated from `verify/traceability.json` |
| `SCREEN_STATE_INVENTORY.md` | Surface × {loading, empty, error, conflict, unavailable, revoked, partial configuration}, and fact × the same |
| `Prototype - Workspace Shell and Dashboards.dc.html` | The drawing, §S1–S12. Every value is a **wire field name**, never a number |
| `screenshots/` | Each section at 390, 768 and 1280 |
| `AUDIT.md` | The readiness audit and every verification result, each with its non-vacuity control |
| `verify/check-traceability.mjs` · `verify/traceability.json` | Design ↔ contract check: routes, fields, capabilities, recorded absences and prototype slots. Paths are canonical POSIX on every platform, and a built-in self-test (`--self-test`, also run before every check) proves that under Windows path semantics |
| `verify/audit-prototype.mjs` | Browser measurement: overflow, contrast, keyboard and structure |
| `tools/build_prototype.py` | Rebuilds the prototype from one set of helpers, so a slot cannot drift between sections |

## Rules held throughout

- **No invented field.** Every rendered value is a field some merged route returns, and the checker fails otherwise.
- **No hard-coded value.** No amount, count, percentage, date, deadline, cutoff, window, allowance, rate, fee or schedule, and no legal, consent or provider sentence. Copy that is legal in nature comes only from administrator-published versions (screen 47). Until then the design shows «متن شرایط هنوز منتشر نشده است.»
- **Absent ≠ zero.** A zero the server returned is drawn as a zero. A fact no route returns is drawn as a dashed **unavailable** block with its reason, with no number and no "coming soon".
- **Navigation is not authorization.** The shell hides. The server refuses.
- **Capability-driven, never vertical-driven.** A laser centre, maison, retail or B2B business gets the same dashboard (`V33-DEC-030` D1).
- **Owner and delegated access are distinguished by text and shape.** A delegated reader sees no write controls at all, not disabled ones.

## Out of scope, deliberately

Implementing #264, #265, #226, #255 or #237 (each has its own PR). Any backend route or field. The dispute, appeal, reception-calendar and B2B surfaces beyond their unavailable or absent state. Legal, privacy, payment-provider or AI-provider approvals. A new ADR or decision card.

## Open items for the reviewer

1. **G1 and G2** (screen 51 §13): no issue exists for a seller booking-credit balance read or an entitlement-usage read. They are for the owner to triage and are not created here.
2. **Single-capability moderator:** the design keeps a one-card landing rather than redirecting to the queue (screen 52 §3, with the reasoning). A redirect is a small presentational change if preferred.
3. **Fund-state terminology** is inherited unchanged from the gap pack, whose open item 2 (ratify the Persian terms) still stands.
