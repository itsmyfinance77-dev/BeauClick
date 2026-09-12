# 44 — Admin: collection-policy publication and the enforcement control plane

**Prototype:** `Prototype - Admin Control Plane.dc.html` §01–§03
**Baseline:** `6695234eded1` (revised 2026-09-12)
**Stories:** #83 (`#41d-1`) · **#95 (`#58b-1`) and #141 (`#58b-2`) — merged and closed** · ADR-048, ADR-050

> **Correction, 2026-09-12.** The first version of this spec recorded the control plane as ratified with zero implementation. That was true when written and is false now: `services/commercial-policy/src/enforcement/*`, migration `20260917100001_create_booking_credit_enforcement_controls.sql` and the `booking-credit-activation` / `booking-credit-enforcement` PG suites are merged. The operator **screens** remain unbuilt frontend.

## 1. The admin commercial controller has 27 routes

18 plan/price-schedule routes (specified in `40_ADMIN_COMMERCIAL_CATALOGUE.md`) plus **9**
booking-collection-policy routes added by #83 to the same class:

| Method | Route | Audit action |
|---|---|---|
| GET | `/v1/admin/commercial/collection-policies` | — |
| POST | `/v1/admin/commercial/collection-policies` | `commercial.collection_policy_created` |
| GET | `…/collection-policies/:policyKey/versions` | — |
| GET | `…/collection-policies/:policyKey/versions/:version` | — |
| POST | `…/collection-policies/:policyKey/versions` | `…version_drafted` |
| PUT | `…/collection-policies/:policyKey/versions/:version` | `…version_updated` |
| POST | `…/versions/:version/publish` | `…version_published` |
| POST | `…/versions/:version/retire` | `…version_retired` |
| DELETE | `…/versions/:version` | `…version_discarded` |

All on the class-level privileged `bc_manage_commercial_plans`, with a live revocation re-check per
request and the audit row written inside the same transaction as the domain change. No response
returns `createdByUserId`, `publishedByUserId` or `retiredByUserId`.

## 2. The eight lifecycle states are not one vocabulary, and the legend says so

**Stored:** draft, published, retired. **Derived from the activation window:** active (published and
the database clock is inside its window), superseded (published, window closed because a newer
version is active). **External and operational gates, belonging to no version:** legally blocked
(#42), payment-provider blocked (#47), emergency stopped (#95's kill switch).

Collapsing these eight into one column would invent a state PostgreSQL does not recognise. The
legend renders the three groups distinctly.

## 3. The version form has no defaults

Collection mode is exactly three values; a deposit rule is only valid in deposit mode, and deposit
mode requires one. `percentageBase` is **required policy data with no default**, over exactly
`{service_subtotal, service_total}` — the question no decision had answered, which blocks
percentage-deposit publication until it is chosen. No field carries a pre-filled example, a
placeholder zero or a suggested value. Activation start is absent from the form: the database
determines it at publication and it is never earlier than publication.

## 4. Publish dialog

Irreversible; states the activation instant, the count of sellers enrolled on the key, the fact that
only orders created after this instant are affected, and — explicitly — that **existing bookings are
unchanged**. The previously active version of the same key closes in the same instant, so two
versions are never simultaneously active. Rollback is publishing a new version; no route edits or
deletes history, because none exists.

## 5. The four independent planes (§02) — implemented, seven routes

`BookingCreditEnforcementController` is a **separate controller** from `CommercialCatalogueController`, mounted at `v1/admin/commercial/booking-credit-enforcement` with the same class-level privileged `bc_manage_commercial_plans`, the same live revocation re-check and the same boot-time audit assertion. So the admin commercial namespace now carries **34 routes: 27 catalogue + 7 enforcement.**

| Method | Route | Audit action | Notes |
|---|---|---|---|
| GET | `/booking-credit-enforcement` | — | control state; writes nothing |
| GET | `/booking-credit-enforcement/preview` | — | aggregate partition; non-mutating |
| POST | `/booking-credit-enforcement/transitions` | parties governed | **set-based** — no per-seller selector |
| POST | `/booking-credit-enforcement/exemptions` | parties exempted | set-based |
| POST | `/booking-credit-enforcement/kill-switch/engage` | kill switch engaged | platform-wide |
| POST | `/booking-credit-enforcement/kill-switch/release` | kill switch released | platform-wide |
| POST | `/booking-credit-enforcement/activation` | activated | once, atomic; `409` carrying preview counts when refused |

Every mutation body is **exactly a reason** (3–500 characters) and nothing else — `forbidNonWhitelisted` rejects any other field, so there is no channel through which a caller could name an owner, user, professional, business, party, subscription, grant, quantity, generation or state. The governance commands are set-based by design, which is why no screen here has a seller picker. There is no `activation/preview` route (preview is the shared `GET /preview`) and **no deactivation route**: reversal is not an ordinary transition.

### The ratified rules the screens must keep

Rollout state (a PostgreSQL-enforced singleton control row holding no commercial number) ·
the unchanged entitlement ledger · an explicit **monotonic** per-party governance fact
(`legacy_exempt | governed`, closed cause, actor, one row per party) · a platform-wide persistent
audited emergency kill switch. None substitutes for another. Zero credit never means unlimited.
A constant `true` for the business-policy plane is **rejected**.

Existing sellers stay legacy-exempt until explicitly transitioned; no migration, seed, backfill or
inference governs anyone; a governed seller stays governed through exhaustion, retirement,
supersession and restart. Seller creation under active enforcement writes the governance fact in the
same transaction, writes no credit, and **fails the creation** if it cannot complete.

The preview is aggregate-only, non-mutating, single-snapshot, and returns **no seller-identifying
data** — so the screen deliberately has no browsable seller list; its absence is the design, not a
gap. Global activation **fails closed** while any eligible seller remains unintentionally
legacy-exempt, and the button is disabled with that reason stated.

Direct SQL, environment variables, startup flags and unreachable internal methods are rejected as
operator surfaces: none of them carries audit, reason or a live access re-check. No new customer- or
seller-facing surface is created.

## 5-b. What is still only designed

The operator screens themselves. The backend is complete; no admin frontend consumes these seven routes. The design is therefore **ready for implementation**, not a placeholder for a missing contract.

## 6. Boundaries this surface does not cross

No commission mode, rate or basis (that is #43, and contradiction C-5 is open). No cancellation
template, cancellation-window range, no-show grace range, dispute deadline or customer copy (that is
#42 plus Legal). No settlement schedule or reserve rule (#43). No promotional-credit expiry (open).
Configurability grants no legal or external authority: publishing a policy changes what the platform
records, not what a bank does. Optional four-eyes approval is a named future decision and is
deliberately neither designed nor promised.
