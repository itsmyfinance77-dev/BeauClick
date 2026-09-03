# 40 — Admin Commercial Plan and Price Catalogue

**Story:** #40 (`#40a`) · **ADR:** ADR-041 · **Decision:** `V33-DEC-009` (structure only) · **Capability:** `bc_manage_commercial_plans` (privileged, `administrator` only)
**Audited baseline:** `itsmyfinance77-dev/BeauClick@master`, resolved this pass to commit `12c92f974529...` — identical to the baseline commit named in the sync brief. `origin/master` has **not** advanced past it; there is no intervening commit to triage.
**Repository files read in full for this pass:** `docs/roadmap/v3/adr/ADR-041-commercial-plan-and-price-catalogue.md`; `v3/packages/commercial-policy-contract/src/{commercial-catalogue-contract.ts, commercial-policy-contract.ts}`; `v3/services/commercial-policy/src/catalogue/{commercial-catalogue.controller.ts, .service.ts, .dto.ts, .entities.ts, .exceptions.ts, commercial-subject-data.contract.ts, base-workspace-is-not-a-code-path.spec.ts}`; `v3/services/commercial-policy/src/commercial-policy-control.gate.ts`; `v3/database/migrations/commercial/20260902800001_create_commercial_catalogue.sql`; `v3/database/migrations/identity/20260902800002_add_commercial_plan_capability.sql`; `v3/libs/auth/src/{capability.guard.ts, privileged-capability.port.ts}`; `v3/libs/audit/src/audit-enforcement.ts`.

**Not read (no tool access in this workspace):** the GitHub Issue #40 thread itself and PR #66's review conversation. Everything the issue is reported to require was cross-checked instead against the merged code, the ADR that restates the issue's asks line-by-line, and `docs/roadmap/v3.2/V3.2_PLUS_CAPABILITY_CATALOG.md`'s "Delivered 2026-09-02" entry, all three of which agree.

## Contradiction found — route count

The sync brief states "16 administrator routes." The merged `CommercialCatalogueController` declares **18**: 2 catalogue-key routes (`GET/POST plans`, `GET/POST price-schedules` = 4, not 2 — see table below), 7 price-schedule-version routes, 7 plan-version routes. See the full table in §1. Design proceeds against the real 18, not the stated 16; nothing was silently forced to match the brief's number.

No other contradiction was found between the backend, ADR-041, and `V33-DEC-009` as ADR-041 states it. `V33-DEC-009` itself (the decision register entry) was not re-read verbatim this pass — ADR-041 quotes and restates its structural content extensively and consistently across every file read, so it is treated as accurately represented rather than re-derived from the register.

## 1. Route-to-screen matrix (all 18 routes)

| Method | Route | Screen element | Audit action |
|---|---|---|---|
| GET | `/v1/admin/commercial/plans` | Plan catalogue list | — (read) |
| POST | `/v1/admin/commercial/plans` | "New plan key" action | `commercial.plan_created` |
| GET | `/v1/admin/commercial/price-schedules` | Price schedule catalogue list | — |
| POST | `/v1/admin/commercial/price-schedules` | "New schedule key" action | `commercial.price_schedule_created` |
| GET | `/v1/admin/commercial/price-schedules/:key/versions` | Schedule version list (per key) | — |
| GET | `/v1/admin/commercial/price-schedules/:key/versions/:v` | Schedule version detail + tiers | — |
| POST | `/v1/admin/commercial/price-schedules/:key/versions` | "Draft new schedule version" form | `commercial.price_schedule_version_drafted` |
| PUT | `/v1/admin/commercial/price-schedules/:key/versions/:v` | Draft schedule version editor (save) | `commercial.price_schedule_version_edited` |
| POST | `/v1/admin/commercial/price-schedules/:key/versions/:v/publish` | Publish schedule version dialog | `commercial.price_schedule_version_published` |
| POST | `/v1/admin/commercial/price-schedules/:key/versions/:v/retire` | Retire schedule version dialog | `commercial.price_schedule_version_retired` |
| DELETE | `/v1/admin/commercial/price-schedules/:key/versions/:v` | Discard draft schedule version | `commercial.price_schedule_version_discarded` |
| GET | `/v1/admin/commercial/plans/:key/versions` | Plan version list (per key) | — |
| GET | `/v1/admin/commercial/plans/:key/versions/:v` | Plan version detail | — |
| POST | `/v1/admin/commercial/plans/:key/versions` | "Draft new plan version" form | `commercial.plan_version_drafted` |
| PUT | `/v1/admin/commercial/plans/:key/versions/:v` | Draft plan version editor (save) | `commercial.plan_version_edited` |
| POST | `/v1/admin/commercial/plans/:key/versions/:v/publish` | Publish plan version dialog | `commercial.plan_version_published` |
| POST | `/v1/admin/commercial/plans/:key/versions/:v/retire` | Retire plan version dialog | `commercial.plan_version_retired` |
| DELETE | `/v1/admin/commercial/plans/:key/versions/:v` | Discard draft plan version | `commercial.plan_version_discarded` |

No route on this surface accepts an actor/owner/subscriber id (whitelist validation rejects unknown fields with 422 — `forbidNonWhitelisted: true`); no route returns `*_by_user_id`. There is no quote/preview route and no seller-facing route anywhere on `/v1/admin/commercial/*` — confirmed against the controller's own docblock.

## 2. Requirement-to-state matrix

| Requirement (Issue #40 / ADR-041) | Screen state designed |
|---|---|
| List plan keys, versions, lifecycle | Plan list table + expandable version table, §19 prototype |
| Lifecycle badges, non-color-only | Text-labeled pill (پیش‌نویس / منتشرشده / بازنشسته) + distinct icon shape per state |
| Activation windows | Start/end columns, "بدون پایان" for null end |
| Auto-assignable status | Dedicated column + D-7 callout card |
| Safe empty state | "هیچ طرحی هنوز تعریف نشده" card |
| Loading state | Skeleton rows |
| Fetch failure | Error card + retry |
| Create draft (plan) | Full form matching `WritePlanVersionDto` 1:1 |
| Create draft (schedule) | Full form matching `WriteScheduleVersionDto` 1:1, tier editor |
| Dirty-state warning | Banner on the editor mockup |
| Save in progress / success | Button state + toast |
| Validation failure | `COMMERCIAL_TERMS_INVALID` list, verbatim shape |
| Stale/conflict | `COMMERCIAL_LIFECYCLE_CONFLICT` — "the version stopped being a draft" copy, generic per the service's own wording |
| Publish confirmation + reason + frozen-terms summary | Dialog mockup |
| Publish immutability statement | Explicit sentence in the dialog |
| Publish in progress / success | Button state + resulting badge change |
| Overlapping-window refusal | `COMMERCIAL_ACTIVATION_OVERLAP` — "بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد" |
| Incomplete/missing schedule refusal | `COMMERCIAL_NOT_CONFIGURED` on publish-time schedule check |
| Retire: reason, confirm, future-only explanation | Dialog mockup, copy scoped to "future selection" only |
| Retire: no claim about existing grants | No such claim written anywhere (there is nothing to claim — no grant table exists yet) |
| Retired cannot edit/reactivate; restore = new version | Explicit note under the retired badge |
| Retire in progress / success / already-unavailable | Button state + generic not-found-shaped conflict |
| Immutable schedule versions | Retired/published schedule rows shown read-only |
| Flat price = one tier | D-7 schedule shown as its real one-tier, zero-price shape |
| Tier editor, integer IRT, no floats | Editor mockup, `type="number" step="1"`, ₮ formatted as Persian digits over an unchanged integer |
| Gap / overlap / invalid-boundary errors | Three labeled error rows in the tier editor gallery |
| Activation-window conflict (schedule) | Same `COMMERCIAL_ACTIVATION_OVERLAP` shape, schedule-scoped |
| D-7: key, published, zero price, auto-assignable, zero/empty entitlements, explicit version | Dedicated D-7 card, every fact sourced to the migration |
| D-7 values not final; future changes need new version | Explicit sentence on the D-7 card |
| Permission-required / access-revoked | Two dedicated states in §8 |
| Mandatory reason on every mutation | Reason field on every form/dialog; never optional |
| No impersonation | No actor field anywhere; documented in the a11y/audit callout |
| No `*_by_user_id` / audit internals on reads | Confirmed absent from every list/detail mockup |

## 3. Implemented-now vs. later-story

**Implemented now (designed):** plan catalogue, price-schedule catalogue, immutable versioning, lifecycle (`draft→published→retired`), database-enforced non-overlapping activation windows, tier schedules with exact-integer resolution, the `D-7` base-workspace row, `bc_manage_commercial_plans`, mandatory-reason audited mutations, live revocation re-check.

**Not implemented / later story — none of it appears in this design:** seller plan selection (#56/`#40b`), subscription history and credit grants (#56), custom-quantity purchase/top-up (#57/`#40c`), booking-credit balance/consumption/return (#58/`#40d`), booking confirmation without online payment (#41), real payment/settlement/recurring billing (#47), final prices/allowances/policy bounds/legal wording (#46).

## 4. Open values (retained under #46, none invented)

Plan display names, billing-term lengths, booking-credit allowances, staff-seat counts, location counts, capability bundles, all schedule tiers and unit prices, UI preset quantities, and any legal/policy copy. Every number shown in the prototype's forms is marked SAMPLE. The one real, non-sample data point is `D-7` itself, exactly as seeded: published, zero price, auto-assignable, zero/empty entitlements.

## 5. Accessibility

RTL-first (workspace default `dir="rtl"`); every table and dialog reachable by keyboard with visible focus rings; lifecycle state conveyed by text label **and** a distinct icon shape, never color alone; mutation results (save/publish/retire/discard) announced via `aria-live="polite"`; genuinely disabled controls (`disabled` attribute, not a styled-only look) while a request is in flight or a field is out of scope for the current lifecycle state; confirmation dialogs move focus to their heading on open and return focus to the triggering control on close/cancel; wide tables (plan versions, tiers) scroll horizontally within their own container rather than breaking the page; Persian digits render over the same integer the API returns — no value changes, only its glyphs.
