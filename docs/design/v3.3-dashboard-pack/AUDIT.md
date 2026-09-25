# #45 — readiness audit and verification record

**Date:** 2026-09-25 · **Implementation baseline:** `master` `2e3da4a43482680db5104c1e78dba48a8d2a18f4` (V3 CI run 334, success) · **Design baseline:** `design/claude-design` `4b5b120f3493b76f0ba4147d0712d1afbaea2293`.

Every result below was produced by a command in `verify/` and was made to fail at least once on purpose. A check that has never failed has not shown that it can.

## 1. Readiness audit (before any design edit)

Posted on the issue: <https://github.com/itsmyfinance77-dev/BeauClick/issues/45#issuecomment-5831678985>.

- **Verdict: READY at 13 SP, design only.** The estimate stays the same and nothing is split off. The outcome is one coherent design. Every surface without a merged contract is designed as an explicit unavailable state, as `V33-DEC-039` "Frontend / design consequences" requires, and no backend work is requested.
- **Ownership:** no open PR, and no other branch or worktree claimed #45 (all 36 open issues and every PR were read on 2026-09-25).
- **Placement (owner decision, 2026-09-25):** this sibling pack goes to `design/claude-design` through its own reviewed PR. A separate master record PR follows and closes #45.
- **Lifecycle:** `status:proposed` → `status:ready` (after the audit comment) → `status:in-progress` (after `design/45-multi-workspace-dashboard` and its worktree existed). Type, priority, SP, track and milestone are unchanged.
- **Gaps found that the design renders rather than fills:** reception has no role (`V33-DEC-030`, `V33-DEC-033` R1). Disputes and appeals have no route (#162, #180). The booking-credit balance has no seller read. Seat and location usage have no read. The seller-owed receivable does not exist (#177). There is no labelled seller workspace list (#210). There is no `createdAt` on `/v1/me` (#226). There is no monthly series (#255). The reported image is not addressable (#265). G1 (credit balance) and G2 (usage) have **no issue**. They are listed for owner triage in screen 51 §13 and are not created by this PR.

## 2. Contract traceability — `verify/check-traceability.mjs`

```
routes derived: 291 · cited: 41 · fields checked: 125 · capabilities: 11 · absences: 4 · prototype slots: 42
PASS
```

| Non-vacuity control (each applied, run, then restored; a restored run was PASS again) | Result |
|---|---|
| added field `createdAtBogusField` to `GET /v1/me`, plus a cited route `GET /v1/me/disputes` | exit 1: both reported |
| pointed each of the four absences at a fact that exists (`balanceFor` without its exemption, route pattern `funds`, `'manager'` for `'reception'`, `createdAt` in `financial.controller.ts`) | exit 1: all four reported |
| renamed the prototype slot `‹staffSeats›` to `‹staffSeatsUsed›` | exit 1: `prototype slot not traceable: staffSeatsUsed`. The file was restored and `cmp` confirmed it byte-identical |
| first real run | exit 1: four `staff-management` fields cited against the wrong file. The fix is a correct citation (`staff-management.service.ts`), not a weaker check |

## 3. Responsive — `verify/audit-prototype.mjs`

Chromium 1194 (Playwright). The prototype is served over HTTP and rendered at **390, 768 and 1280**.

| Width | `scrollWidth` / `innerWidth` | Overflowing or clipped elements | Console errors |
|---|---|---|---|
| 390 | 390 / 390 | 0 | 0 |
| 768 | 768 / 768 | 0 | 0 |
| 1280 | 1280 / 1280 | 0 | 0 |

The probe flags any element that extends past the viewport **or past an `overflow: hidden` ancestor on either side**. RTL content overflows to the left, which an earlier, weaker probe missed. That probe passed a real defect: desktop artboards clipped their tables at 390. It was caught by looking at the screenshots, the probe was strengthened, and the layout was fixed (`min-width: 0` on flex children, and every table inside a captioned, keyboard-reachable scroll region). Intentional `overflow-x: auto` regions are exempt, because scrolling there is the design.

**Non-vacuity:** a 900 px child inserted into the 390 phone artboard gives exit 1 with `DIV [-560,340] in [40,350]`.

Screenshots of every section at all three widths: `screenshots/{390,768,1280}-s{0..12}.png` (39 files).

## 4. Contrast

Every element with its own text node (496 per width) is measured against the first opaque ancestor background. A gradient counts as its **darkest** stop. OKLCH is converted to sRGB in the page. Thresholds are 4.5:1 for normal text and 3:1 for large text (≥ 24 px, or ≥ 18.66 px at weight ≥ 700).

| Width | Checked | Failures | Minimum ratio |
|---|---|---|---|
| 390 | 496 | 0 | 5.76 |
| 768 | 496 | 0 | 5.76 |
| 1280 | 496 | 0 | 5.76 |

The pack's muted text is **darker** than the gap pack's (`oklch(0.47 …)` instead of `0.58`), chosen so small captions clear 4.5:1 on every surface used. Disabled controls are reported separately and none fell below threshold.

**Non-vacuity:** a heading set to `oklch(0.8 0.01 60)` gives exit 1 with `H3 "حساب" 1.87 < 4.5`.

## 5. Keyboard and structure (1280)

| Check | Result |
|---|---|
| tab stops reached / expected (a radio group counts as one stop) | 78 / 78 |
| order equals DOM order | yes |
| each stop reached once | yes |
| stops without a visible focus indicator | 0 |
| `main` has `dir="rtl" lang="fa"` | yes |
| controls without an accessible name · unlabelled fields · positive `tabindex` · unnamed `role=img` or `region` · `table` without `caption` · `th` without `scope` · `fieldset` without `legend` | 0 · 0 · 0 · 0 · 0 · 0 · 0 |
| workspace radios pre-selected | 0 (a pre-checked radio in the first build contradicted screen 51 §2.3 rule 2 and was removed) |

**Non-vacuity:** removing the link focus style gives `59 stops without a visible focus indicator`. `tabindex="3"` on a heading gives `reached 78 of 79` and `positive tabindex`. Deleting the reason field's `<label>` gives `unlabelled field: <textarea … id="why"`. Each exits 1.

## 6. RTL

`dir="rtl"` and `lang="fa"` are on `html` and `main`. Every value slot, route, field name and code span is isolated with `direction: ltr; unicode-bidi: isolate`, so a Latin run never reorders the Persian sentence around it. This is visible in every screenshot. Access-mode shapes sit at the logical start. Section and card order read right to left at every width (the screenshots are the evidence).

## 7. Design-source synchronisation

- **Nothing in the canonical snapshot or the gap pack was modified.** The diff is this new folder plus one section in `docs/design/README.md` and one row in `docs/design/SNAPSHOT_HISTORY.md`, the same footprint the gap pack left (`958a95c`).
- The prototype reuses the gap pack's `support.js` and fonts by relative path, so the branch does not carry a third copy of either.
- Specs cited and not restated: 03, 04, 12, 13, 20, 21, 25, 26, 27, 28, 36, 37, 42, 45, 46 (+ amendment with R1–R3), 47, 48, 49, 50, and `V3_ADMIN_UX.md`, `V3_INFORMATION_ARCHITECTURE.md`.
- Amendments this design makes to existing specs are listed in screen 51 §12, each with the story that implements it.

## 8. Not claimed

A static prototype proves markup, layout, contrast and keyboard reachability. It does **not** prove WCAG 2.1 AA conformance of the product. Screen-reader output in RTL, live-region timing, real-device target size, reduced-motion behaviour and focus return from dialogs must be measured at implementation. No legal, privacy-counsel, payment-provider or AI-provider fact is asserted anywhere in this pack.

## 9. Environment notes

- The dc runtime loads React and Babel from pinned `unpkg.com` URLs. The sandbox browser did not trust the egress proxy's CA, so the audit fetched those three pinned files with `curl` (which verifies against the proxy CA bundle) and served them to the page through a Playwright route. TLS verification was never disabled. `audit-prototype.mjs` takes the vendor directory as an optional argument. Without it, the pinned URLs load normally.
- `design/claude-design` shares no recent history with `master` (merge base `1e5f519`). This PR is based on and targets the design branch only.
