# V3 Migration Plan

Status: this discovery pass's output (2026-08-19), synthesizing `V3_MIGRATION_MATRIX.md` (component-level DIRECT REUSE / REFACTOR / BUSINESS-RULE EXTRACTION / TEST-SPEC REUSE / REIMPLEMENT / RETIRE classifications — read that document for the full per-component detail; not repeated here) into a migration strategy, phased roadmap, code-reuse summary matrix, and risk register. Governed by `ADR-010-migration-strategy.md`.

**This is a discovery/planning document only. No V3 implementation has started. No migration has been executed.**

---

## 1. Migration strategy

Per `ADR-010`: **clean V3 rebuild**, not big-bang data migration, strangler-fig, or dual-run — because **BeauClick has no production dataset yet**. This single fact eliminates the live-cutover risk category that normally drives that choice. V2 remains a reference implementation and the source of validated business rules/tests; V3 is built fresh against those extracted rules, then re-seeded with reference/demo data.

**Precondition to re-verify before Phase 1 implementation actually starts:** confirm "no production dataset" is still true at that time — if real users/transactions have accumulated on V2 between this discovery pass and V3 implementation start, this plan's premise changes and must be revisited (`ADR-010` risk).

## 2. Entity classification

| Disposition | What it means here | Representative entities |
|---|---|---|
| **Migrate (reseed)** | Reference/static data with no live-user rows to preserve — direct reuse of the data itself. | Province/city/district tables, specialty taxonomy. |
| **Rebuild from business rules** | Schema + business rules ported per `V3_MIGRATION_MATRIX.md`'s classifications; no literal row migration since no production rows exist. | Booking, financial, campaigns, loyalty, verification, reviews, chat, AI conversations, notifications, privacy, referral, Beauty Journey (`GAP-29`). |
| **Discard, no migration path needed** | WordPress/WooCommerce-native mechanisms with zero portable value. | WooCommerce order/coupon/tax-class data shapes, the mount-point DOM-signaling frontend architecture, WP-Cron job *registration* (the jobs' policies do migrate, per §5 below), CPT/postmeta storage itself. |
| **Optional history** | Not code or data, but worth deliberately preserving. | V2's git history; the entire `docs/roadmap/*` corpus (this document set, `PRODUCT_GAP_REGISTER.md`, `VERSION_2_ARCHITECTURE_PLAN.md`) as institutional memory and the evidence base every ADR in this set cites — **do not discard**, even though nothing here is "data" in the migration sense. |

## 3. Code reuse matrix (summary — see `V3_MIGRATION_MATRIX.md` for full per-component detail)

| Domain | Direct reuse | Extract logic (business-rule / test-spec) | Rewrite (refactor / reimplement) | Retire |
|---|---|---|---|---|
| Booking/Availability/Waitlist/Reschedule | Ranking algorithm (pure scoring math) | Hold/claim/cancel state machine, reschedule rules, waitlist "offer never reserve" invariant, REST contract shape | Availability re-platform, signal collection, CRM search/filter (scale ceiling) | WP-Cron mechanism, `BookingMailer`'s raw `wp_mail()` |
| Provider/Marketplace | Location hierarchy (already relational), Persian digit-folding | Verification state machine, evidence-storage rules, denormalization strategy, review rules | CPT→relational re-platform (**largest single item**), staff model, verification schema | Portfolio management (half-built, redesign from requirements) |
| B2B | — | Account-approval state machine, tier-pricing matching logic, quote lifecycle + IDOR fix, test suite | Order-conversion entry point (must go through Commerce's unified pricing engine) | wp-admin B2B forms |
| Commerce (replaces WooCommerce) | Idempotency-guard pattern (design) | Booking↔order bridge rules, payment-status glue, auto-refund/refund-on-cancel rules, receipt/my-orders rules, currency formatting | Booking→Order idempotency (**fix `GAP-03`**, don't port the gap) | Every WooCommerce-native data shape (coupons [unused], tax classes) — **must not be recreated under a different name** |
| Payment | — | — (no real gateway ever built) | Provider abstraction + real gateway integration — **net new** | Dev-only COD gateway (keep only the fail-closed-by-default *pattern*) |
| Campaign | Usage-tracking idempotency pattern | Eligibility rules, no-compounding-with-Membership discipline (44-test-covered) | **Fix `GAP-04`'s TOCTOU race**, don't port it; fold into Commerce pricing engine | Admin UI |
| Financial | Idempotency pattern, cross-professional isolation pattern (post-`GAP-05`) | Commission formula, refund-at-original-rate rule, settlement rules | Ledger append-only guarantee → **real DB enforcement** (`GAP-01`) | Admin UI (wp-admin-specific) |
| Loyalty/Membership | — | Point-value/tier-threshold provisional numbers (`GAP-10`), idempotency test suite | Points/tiers/benefits schema; Membership **merges into loyalty-service** | — |
| Referral | — | Attribution/qualification rule, 50/50-split (provisional), test suite | Cookie-based attribution → explicit attribution parameter | — |
| Notifications | Provider-abstraction pattern (identical shape reused 3× already) | Dispatch idempotency-key shape, opt-out preference model | Real SMS/email/push channel delivery — **net new**, never exercised against a real provider; in-app center — **net new** | Synchronous no-queue dispatch model (revisit) |
| Privacy | State-machine shape, OTP-gated-confirmation pattern | Domain-by-domain retain/anonymize/delete matrix (hard-won legal reasoning) | "Thin orchestrator" → **formalize as a typed self-registering contract** (closes the `PRIV-06` blind-spot class) | — |
| Analytics | "One shared read-model, never two engines" discipline | Metric definitions | Event log → **formal, versioned event store** (`V3_EVENT_CATALOG.md`) | — |
| AI | Provider-abstraction, two-stage authorization/curation, output-validation — all proven patterns | Safety-guard concepts (medical gate, injection blocklist) | One-thread-per-tenant limitation — **revisit, don't re-adopt** (`GAP-12`) | Rule-based fallback's specific Persian-keyword implementation (concept survives, code doesn't) |
| Search | Denormalization *strategy* | — | Free-text `LIKE` matching → OpenSearch (**genuine improvement, not a port**, `GAP-14`) | — |
| Beauty Journey (`GAP-29`) | — | Profile/goals/timeline data shapes, AI-context seam (`infer_ai_defaults`) | Fold into ai-service as a bounded module (preliminary — needs its own boundary review) | — |
| Frontend/Design system | Design tokens, primitive components (Button/Card/Chip/Modal/etc.), Jalali calendar math, Persian formatting, RTL pattern | `api.ts` envelope/error-hygiene pattern | Feature components' data layer (UI mostly survives, API layer doesn't) | Mount-point architecture (`data-bc-*-trigger`), `storeApi.ts` (Woo Store API wrapper) |
| Authentication/Authorization | Phone canonicalization, "never trust client-supplied ownership" pattern, SMS provider abstraction | OTP rules (shape, not the numbers), RBAC capability grants, phone-as-identity resolution rules | Session/token mechanics — **net new**, no V2 token infrastructure exists at all; ownership-resolver primitive — **fix `GAP-08`**, accept an owner-resolver not a raw ID | — |
| Admin | Audit-log shape, separation from analytics store | Audit-logging *rules* | Enforcement model → structural (registration-time), fixing a **3×-recurring bug class** | 16 wp-admin PHP pages (capability model is the real contract, not the forms) |
| SEO | — | Title/description-per-page-type rules, thin-page canonical-collapse discipline, "never fabricate structured data," query-string faceted-navigation pattern | `wp_head`/`document_title_parts`/`WP_Sitemaps_Provider` mechanism → SSR/SSG framework equivalent (net rebuild) | — |

## 4. Migration difficulty ranking (highest to lowest risk)

1. **Provider CPT→relational re-platform** (`WORDPRESS_EXIT_MATRIX.md` §2) — highest risk: highest-traffic read path (marketplace search/profile), largest schema-shape change, WP ownership/capability machinery has no direct equivalent.
2. **Commerce pricing-engine unification** (`beauclick/booking/after_create`'s implicit priority-ordering → an explicit, coordinated pricing-rule-provider chain) — real, currently-load-bearing business logic expressed as implicit WordPress filter priorities.
3. **Payment gateway integration** — net-new, zero V2 precedent, real-money correctness stakes.
4. **Financial ledger DB-level immutability** — well-understood *what* to build (ADR-009), contingent on target hosting actually granting the needed Postgres role permissions (a real, previously-encountered constraint in V2's own MySQL hosting).
5. **Authentication token mechanics** — net-new, but well-trodden (JWT/refresh-token patterns), riding on already-proven authorization *rules*.
6. **Everything else** — mechanical schema/logic translation with a well-understood target shape (34 `wp_bc_*` tables, 27 REST controllers, 11 cron jobs) — low-to-medium difficulty, high confidence, per `WORDPRESS_EXIT_MATRIX.md`.

## 5. Roadmap

### V3 Phase 0 — Architecture
**Goal:** close the two remaining discovery gaps (`GAP-09` SEO, `GAP-29` Beauty Journey service boundary) and get this entire document set (Architecture Discovery, Migration Plan, Gap Register, 10 ADRs, Wordpress Exit Matrix) reviewed and explicitly approved.
**Dependencies:** none — this phase is what this task itself produces.
**Deliverables:** this document set.
**Definition of done:** explicit stakeholder sign-off recorded; no open `REQUIRED`-severity gap remains undecided (existing `GAP-10`'s provisional numeric policies get a real business sign-off pass, or an explicit decision to defer them past Phase 0 with owner and date).

### V3 Phase 1 — Foundation
**Goal:** identity-service + provider-service (the two highest-risk, most-depended-upon domains) stood up on the target stack, with real auth working end to end.
**Dependencies:** Phase 0 sign-off; target Postgres hosting's actual role-grant capabilities confirmed (blocks Phase 1's financial-service prep work, per ADR-009).
**Deliverables:** identity-service (phone/OTP + JWT/refresh sessions per ADR-008), provider-service (professional/business/service/portfolio as real tables per ADR-001/§2), RBAC/capability model (`WORDPRESS_EXIT_MATRIX.md` §7), object storage for portfolio media + verification evidence (`WORDPRESS_EXIT_MATRIX.md` §10), locations + specialty reference data reseeded.
**Definition of done:** a real user can register via OTP, get verified, create a provider profile, and have it show up in a (even naive, pre-OpenSearch) provider listing — the full identity→provider loop, live-tested.

### V3 Phase 2 — Core value loop
**Goal:** booking-service + commerce-service + payment-service, with the unified pricing engine (§4 item 2) and one real Iranian payment gateway.
**Dependencies:** Phase 1 (provider identity must exist for a booking to reference).
**Deliverables:** booking lifecycle (hold/confirm/cancel/reschedule/waitlist), commerce-service's single order-creation entry point with idempotency (closing `GAP-03` by construction), the unified pricing-rule-provider chain (Campaign + Membership + B2B tiers, closing the uncoordinated-hook risk by construction), payment-service with a real gateway adapter, financial-service with DB-level append-only enforcement (closing `GAP-01` for real).
**Definition of done:** search→book→pay→confirm→complete→review live-tested end to end against a real (even sandbox) payment gateway; financial ledger correctly records commission for a real paid booking; a forged cross-tenant parameter test suite passes (carrying forward the adversarial-test discipline from `V3_SECURITY_MODEL.md` §4).

### V3 Phase 3+ — Remaining domains, implementation sequence
| Sub-phase | Scope | Depends on |
|---|---|---|
| 3a | search-service (OpenSearch), replacing the naive Phase-1 listing | Phase 1 provider-service, Phase 2 booking events for ranking signals |
| 3b | loyalty-service (+ Beauty Journey folded in per `GAP-29`'s resolution, if adopted), referral-service | Phase 2 booking/order-paid events |
| 3c | notification-service (real SMS/email/push — net new, `GAP-11`), in-app notification center (net new) | Phase 1-2 events to notify on |
| 3d | analytics-service (formal event store per `V3_EVENT_CATALOG.md`), admin capability model + structural audit-log enforcement | All prior phases' events |
| 3e | ai-service (customer + professional assistants, two-stage authorization/curation) | Phase 1 identity, Phase 3b Journey-fold decision, Phase 3d analytics for AI usage tracking |
| 3f | SEO (per this pass's §14 findings — frontend SSR/SSG rebuild of marketplace/profile/shop pages, structured data, sitemap) | Phase 1-2 provider/commerce data available to render |
| 3g | Admin application (16-screen equivalent, `WORDPRESS_EXIT_MATRIX.md` §9) | Every domain it administers |

Each sub-phase's own **deliverables/definition-of-done** follows the same shape as Phases 1-2: the domain's core lifecycle live-tested end to end, its adversarial/ownership tests ported from `V3_MIGRATION_MATRIX.md`'s TEST-SPEC REUSE items where they exist, and its events wired per `V3_EVENT_CATALOG.md`.

## 6. Risk register

| Risk | Domain | Severity | Mitigation |
|---|---|---|---|
| "No production dataset" premise goes stale between this discovery pass and Phase 1 start | Migration | High if it happens | Re-confirm explicitly at Phase 1 kickoff, not assumed (`ADR-010`) |
| ~~Target Postgres hosting lacks the grants needed for ledger/audit-log DB-level immutability~~ — **MITIGATED (Phase 1 completion pass, 2026-08-20)**: verified on real PostgreSQL 16 that a **non-superuser** role granted only `INSERT`+`SELECT` has `UPDATE`/`DELETE`/`TRUNCATE` denied by the database, row confirmed unchanged (`database/scripts/financial-role-contract.sql`; automated in `financial-role-contract.pg-spec.ts`). The *capability* doubt that made this unresolvable in V2 is gone. **Residual risk, not zero**: this was proven on a local dev instance — a managed/hosted provider must be re-verified with the same script before Phase 2 relies on it, and `GAP-01` itself stays open until financial-service actually uses these roles. | Financial/Admin | ~~High~~ → Low-medium | Re-run `financial-role-contract.sql` against the real chosen hosting once `V3_INFRASTRUCTURE_PLAN.md` §1 is decided; keep disclosing honestly if a provider can't support it |
| `beauclick/booking/after_create`'s implicit priority-ordering doesn't translate cleanly to an explicit pricing-rule chain (ordering/compounding edge cases missed) | Commerce | Medium-high | Port the 44-test Campaign suite + Membership/Campaign no-compounding tests as the acceptance spec before considering the new pricing engine done, not after |
| Payment gateway integration has zero V2 precedent — first real-money code path in the project's history | Payment | High | Treat as new-feature engineering with its own test/QA budget, not "migration" effort; sandbox-test extensively before any real transaction |
| Iran-specific AI-provider and payment-gateway-callback reachability from V3's chosen hosting (unresolved open question carried forward from `ARCHITECTURE_PROPOSAL.md` §29, never actually settled in V2) | AI, Payment, Infra | High | Resolve hosting/region decision before Phase 1, not discovered mid-build (same warning V2's own Phase-0 doc gave and which this project should not repeat) |
| Microservice-extraction temptation before real load justifies it (scope/complexity creep against `ADR-002`'s modular-monolith decision) | Architecture | Medium | Re-affirm `ADR-002`'s trigger condition (real divergent load or real team growth) before splitting any module into its own deployable |
| Team complexity: one primary author's worth of institutional knowledge (V2's entire git history is single-author) concentrated, no bus-factor redundancy | Team | Medium | Document decisions as ADRs/gap-register entries (already the established practice) rather than tribal knowledge; onboard a second contributor before Phase 2 if team growth is planned |
| GAP-10's provisional numeric policies (OTP timings, commission rate, point values, etc.) get silently re-adopted as final without business sign-off | Cross-cutting | Medium | Explicit sign-off checklist as a Phase 0 exit criterion (§5), not assumed correct because "that's what V2 used" |
| Beauty Journey's service-boundary fold-into-ai-service recommendation (`GAP-29`) turns out wrong once actually reviewed with the same rigor the other 12 got | Architecture | Low-medium | Treat as preliminary, not decided — give it a real evidence-based review pass (mirroring `V3_ARCHITECTURE_PLAN.md` §1's method) before Phase 3b, not defer indefinitely |
| Search relevance/facet requirements turn out to need more than OpenSearch's default configuration for Persian-specific normalization | Search | Low | Budget explicit QA time for Persian/Arabic-Indic digit and typo-tolerance testing in Phase 3a, not assumed to work out of the box |

---

## Cross-references
- `V3_MIGRATION_MATRIX.md` — full per-component classification detail (this document summarizes it, does not replace it).
- `V3_ARCHITECTURE_DISCOVERY.md` — service boundaries, database ownership, tech stack, and this pass's own new findings (SEO, Beauty Journey).
- `V3_GAP_REGISTER.md` — every gap cited above (`GAP-01` through `GAP-29`).
- `WORDPRESS_EXIT_MATRIX.md` — the WordPress-specific dependency detail behind §4's difficulty ranking.
- `docs/roadmap/v3/adr/ADR-001` through `ADR-010` — the individual decisions this plan operationalizes.
