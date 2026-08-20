# WordPress Exit Matrix

Status: this discovery pass's output (2026-08-19), grounded in direct source inspection of V2.4.1 (all 18 `beauclick-*` plugins + the `beauclick` theme), not assumption or the prior V2.3.0-era docs. Every row cites real file:line evidence. Complements `V3_MIGRATION_MATRIX.md` (component-by-component reuse classification) with a WordPress-dependency-specific lens: for each category of WP-core mechanism actually used, what it's for, whether it's real business logic or pure framework plumbing, and how hard it is to leave behind.

Companion finding, cross-referenced throughout: **the majority of BeauClick's real data model already lives outside WordPress's own content model** (post/postmeta/options) — 34 dedicated `wp_bc_*` relational tables (§4) hold nearly everything that matters (bookings, financial ledger, campaigns, loyalty, chat, AI conversations, locations, reviews, verification, wishlist, journey). Only 4 entities (professional/business/service/portfolio profiles) still live as CPT/postmeta, and that is the one genuinely large re-platform (§2).

---

## 1. WP_User / wp_usermeta

| | |
|---|---|
| **Current dependency** | `wp_insert_user()` (account creation), `wp_update_user()` (anonymization on deletion), one repurposed WooCommerce usermeta key (`_billing_phone`, used as BeauClick's canonical phone identifier), two custom deletion-flag meta keys. |
| **Purpose** | Pure identity/auth primitive — the user row itself, plus phone number and a soft-delete flag. No BeauClick profile data lives on the user row; everything role-specific lives in CPTs or `wp_bc_*` tables (post_author-owned, not usermeta-owned). |
| **V3 replacement** | A plain `users` table (`id`, `phone`, `deleted_at`, `deleted_flag`) in identity-service (ADR-008). No meta-table indirection needed — this maps to a normal relational table directly. |
| **Migration complexity** | **Low.** |
| **Priority** | Phase 1 (identity-service is the migration's first domain per ADR-010). |

## 2. Custom Post Types (CPTs)

| | |
|---|---|
| **Current dependency** | 4 CPTs registered in `beauclick-marketplace/src/PostTypes/Registrar.php`: `bc_professional`, `bc_business`, `bc_service`, `bc_portfolio_item`. Ownership via WP's native `post_author` (not a meta field, a deliberate V2 design choice per the file's own docblock). ~7 postmeta keys total: `_bc_city_id`, `_bc_district_id`, `_bc_verification_status`, `_bc_mockup_image`/`_bc_mockup_cover` (professional/business); `_bc_duration_minutes`, `_bc_price`, `_bc_rebooking_interval_days` (service). Each CPT uses `capability_type` + `map_meta_cap: true` tied to custom `bc_*` capabilities (§7). |
| **Purpose** | Real business entities (a professional's/business's public profile, their bookable services, their portfolio) — genuine content, correctly using CPTs for WP's native editing/revision/media tooling per the original v1 rationale (`ARCHITECTURE_PROPOSAL.md` §5). |
| **V3 replacement** | Real relational tables (`professionals`, `businesses`, `services`, `portfolio_items`) in provider-service, with `owner_user_id` replacing `post_author` and the postmeta keys becoming first-class typed columns. This is the single largest schema-shape change in the entire migration — `V3_MIGRATION_MATRIX.md` independently classifies this **REIMPLEMENT**. |
| **Migration complexity** | **High** — not the SQL translation (trivial), but replacing WP's `map_meta_cap`/post-status/post-revision machinery and every place that currently calls `get_post_meta()`/`get_the_ID()` with explicit application-layer equivalents (ownership middleware, a real status enum, no built-in revision history unless V3 adds one deliberately). |
| **Priority** | Phase 1 — sequenced first precisely because it's the riskiest, highest-traffic (marketplace search/profile) re-platform, per `V3_MIGRATION_PLAN.md`. |

## 3. Taxonomies

| | |
|---|---|
| **Current dependency** | One taxonomy, `bc_specialty`, hierarchical, attached to all three public CPTs. |
| **Purpose** | Specialty/category classification (میکاپ، ناخن، پوست و مو، …). |
| **V3 replacement** | A self-referencing `specialties` table (id, parent_id, name, slug) + a join table. |
| **Migration complexity** | **Trivial.** |
| **Priority** | Phase 1, alongside provider-service. |

## 4. wpdb custom tables (`wp_bc_*`)

| | |
|---|---|
| **Current dependency** | **34 distinct tables** across 22 migration files (one per plugin), created via `dbDelta()`. Full per-plugin table list confirmed by direct migration-file inspection: ai (5 tables), auth (3), b2b (3), booking (5), campaigns (2), chat (2), core (2 — audit log, events), financial (3), journey (2), locations (3), loyalty (5), marketplace (6), notifications (2), privacy (1), referral (2), reviews (1). |
| **Purpose** | This **is** BeauClick's real relational schema — already fully outside WordPress's content model. Deliberately never uses cross-plugin foreign keys (WordPress doesn't guarantee plugin activation order — a WP-specific constraint, per `V3_ARCHITECTURE_PLAN.md` §6). |
| **V3 replacement** | Per-module Postgres schemas (ADR-004), with real foreign keys now enforceable within a module (the WP activation-order constraint no longer applies). Ownership assignment per `V3_ARCHITECTURE_PLAN.md` §6, plus Beauty Journey's 2 tables (`bc_beauty_profiles`, `bc_beauty_goals`) newly assigned in this pass (`V3_GAP_REGISTER.md` GAP-29) and Wishlist's table (`bc_wishlist_items`, confirmed under marketplace — not previously listed in `V3_ARCHITECTURE_PLAN.md` §6's table either; folds into provider-service alongside reviews). |
| **Migration complexity** | **Low, per-table** — each `dbDelta()` SQL block ports close to 1:1 into a real migration once MySQL types are translated to Postgres equivalents (`JSON`→`jsonb`, etc.). This is the lowest-friction, highest-volume category in the whole migration. |
| **Priority** | Spread across every phase per module ownership — this is the bulk of `V3_MIGRATION_PLAN.md`'s phase-by-phase work, not a single phase. |

## 5. WP-Cron

| | |
|---|---|
| **Current dependency** | 11 scheduler classes (hold-expiry every 5 min, ranking recompute hourly, reminders hourly, notification retry hourly, rebooking/retention/waitlist-expiry/membership-expiry/deletion-processing/export-cleanup daily-to-15-min), all following the same idempotent `wp_next_scheduled()`-guard pattern. Full list with hook names and files confirmed by direct inspection. |
| **Purpose** | **Real business logic**, not framework plumbing — booking-lifecycle integrity (hold expiry), GDPR-style compliance (deletion processing, export cleanup), customer-retention automation, ranking freshness. |
| **V3 replacement** | A real job scheduler (NestJS `@Cron()` + BullMQ, per the release brief's "real job scheduler, not WP-Cron's request-triggered pseudo-cron" mandate, already flagged in `V3_MIGRATION_MATRIX.md`'s Booking section as **RETIRE the mechanism, extract the policy**). Every interval/window value (23–25hr reminder window, 30-day rebooking, 60-day retention, etc.) is explicitly provisional per `GAP-10` — port the job, not the numbers, without a fresh business sign-off. |
| **Migration complexity** | **Low-medium** — the scheduling mechanism is a straightforward swap; the two custom intervals (5-min, 15-min) are trivial outside WP's recurrence-registration ceremony. |
| **Priority** | Per-domain, alongside each job's owning module. |

## 6. Hooks (`beauclick/*` internal event bus)

| | |
|---|---|
| **Current dependency** | ~15 distinct `do_action()` hooks and ~9 `apply_filters()` hooks, confirmed by direct source inspection (not the WordPress/WooCommerce-native hooks, which are separate — see `V3_EVENT_CATALOG.md`). The one hook with real cross-cutting weight: **`beauclick/booking/after_create`** — a genuine pricing/order-composition pipeline, applied once in `BookingController.php`, then chained by three independent consumers at explicit, load-bearing priorities (payments' order-attach at 10, Loyalty's membership discount at 20, Campaigns' discount at 30). This is the exact mechanism `V3_ARCHITECTURE_PLAN.md` §2 names as V2's own most-recurring integration risk. |
| **Purpose** | An in-process event bus / pipeline mechanism. Some hooks are pure lifecycle notification (`booking/completed`, `reviews/submitted`); `after_create` specifically is a real, ordered business pipeline masquerading as a WordPress filter chain. |
| **V3 replacement** | Formal events per `V3_EVENT_CATALOG.md` (ADR-007) for the lifecycle-notification hooks. `after_create` specifically becomes commerce-service's single unified pricing-rule-provider chain (`V3_ARCHITECTURE_PLAN.md` §2) — an explicit, ordered in-process pipeline with a real coordination contract, not implicit WordPress filter-priority numbers. |
| **Migration complexity** | **Medium-high for `after_create` specifically** (it's real, load-bearing, currently-implicit business logic — the priority-number ordering must become an explicit contract); **low** for the rest (near-direct event-catalog mapping). |
| **Priority** | `after_create`'s replacement is the single highest-leverage design decision in `V3_ARCHITECTURE_PLAN.md` (§2) — sequence commerce-service's pricing engine early, once booking-service exists (Phase 2, per `V3_MIGRATION_PLAN.md`). |

## 7. Roles & capabilities

| | |
|---|---|
| **Current dependency** | 5 custom roles (`bc_professional`, `bc_business`, `bc_support`, `bc_moderator`, `bc_platform_operator` — deliberately no duplicate `bc_customer`, shoppers stay WooCommerce's native `customer` role with extra granted capabilities) plus ~15 named `bc_*` capabilities and dynamic per-CPT meta-capabilities, all in one `RoleManager` class with versioned, idempotent re-registration. |
| **Purpose** | The real authorization model — confirmed correct in design and pervasively enforced (`V3_SECURITY_MODEL.md` §3/§9) — expressed through WordPress's role/capability primitives. |
| **V3 replacement** | A NestJS RBAC/CASL policy table carrying the same role→capability grants (extracted as data, per `V3_MIGRATION_MATRIX.md` Authorization section) — including the `bc_platform_operator` narrower-tier pattern, currently correct-but-unused in V2, which V3 should actually default new privileged accounts to (ADR-008 §5). |
| **Migration complexity** | **Medium** — the permission matrix itself ports directly; `map_meta_cap`/`current_user_can()`/per-CPT capability-string generation must become an explicit guard/interceptor layer. |
| **Priority** | Phase 1, alongside identity-service. |

## 8. REST API

| | |
|---|---|
| **Current dependency** | A single `beauclick/v1` namespace, structurally enforced via a shared `RestController` base class that **throws at registration time** if a route lacks a `permission_callback`, or if an admin-gated route lacks a declared audit action — a real architectural guardrail, not convention. **27 controller classes** extend this base across all domains. |
| **Purpose** | The entire custom API surface — real, well-disciplined design (`V3_API_CONTRACTS.md` catalogs the contract shape as worth preserving even where routes themselves are WP-specific). |
| **V3 replacement** | 27 NestJS controllers/modules, one per V2 controller, preserving the response-envelope/error-code/ownership-check discipline `V3_API_CONTRACTS.md` already documents as the thing to carry forward — not the URL structure. The registration-time guardrail (mandatory `permission_callback`) should become a NestJS guard/decorator enforced the same structural way (fails to compile/boot without one), and the same mechanism should be extended to mandatory audit-logging (ADR — ties to `V3_SECURITY_MODEL.md` §7's structural-enforcement requirement). |
| **Migration complexity** | **Low-medium** — the best-positioned category for migration; mechanical 1:1 controller mapping, with the real work being ownership-check reimplementation (ties to §7 and `GAP-08`). |
| **Priority** | Per-domain, alongside each owning module. |

## 9. wp-admin pages

| | |
|---|---|
| **Current dependency** | **16 admin screens**, confirmed exactly matching the figure in prior docs — one top-level "BeauClick" menu (`bc_manage_platform`-gated) plus 15 submenu pages (Overview, Operations & Health, Audit Log, Users, Professional Verification, B2B Accounts, B2B Quotes, Reviews Moderation, Loyalty & Membership, Notifications, Referral, Analytics, Privacy Requests, Financial & Settlement, Campaigns) — all gated on `bc_manage_platform` except Verification (`bc_moderate_verification`) and Reviews Moderation (`bc_moderate_reviews`). |
| **Purpose** | Real, daily-use operator/moderator tooling, not throwaway scaffolding. |
| **V3 replacement** | A genuine internal admin application (NestJS admin API + a small React admin frontend) — per `V3_MIGRATION_MATRIX.md`'s consistent **REIMPLEMENT** classification for every admin-page component across every domain (the underlying capability model is the real contract to reimplement against, not the wp-admin forms themselves). |
| **Migration complexity** | **Medium** — 16 real screens' worth of UI work, though the underlying data/actions already have well-defined REST equivalents (§8) to build against. |
| **Priority** | Spread across phases per owning module; **not** launch-blocking for the customer-facing product, but required before V3 can be operated without falling back to wp-admin. |

## 10. Media/uploads

| | |
|---|---|
| **Current dependency** | Two deliberately separate paths: (a) WordPress Media Library for public, non-sensitive images (portfolio photos, product thumbnails); (b) a fully custom, already cloud-storage-shaped protected-file system for verification evidence (`EvidenceStorage`) — random `storage_key` filenames, content-sniffed MIME validation, directory-level lockdown, auth-gated streaming download, never a public/predictable URL. `BC_STORAGE_DRIVER` exists only as a read-only status-page display flag — **no actual storage-driver abstraction is implemented**; everything is hardcoded to local filesystem today. |
| **Purpose** | (a) is ordinary media management; (b) is a real, already-correct security pattern (`V3_SECURITY_MODEL.md` §8 names this exact pattern as the REQUIRED shape for any V3 feature serving a private file). |
| **V3 replacement** | (a) → standard object storage (S3-compatible, per `ARCHITECTURE_PROPOSAL.md` §25's Iran-reachable-provider note) + a media table. (b) → S3 presigned URLs or equivalent — genuinely one of the more V3-ready subsystems already, since its security model doesn't depend on WordPress at all. |
| **Migration complexity** | **Low-medium.** |
| **Priority** | Phase 1-2, alongside provider-service (portfolio) and provider-service verification (evidence). |

## 11. Theme templates (WooCommerce/PHP template overrides)

| | |
|---|---|
| **Current dependency** | Only 3 real PHP template overrides exist: `archive-product.php`, `content-product.php`, `checkout/thankyou.php` — confirmed by exhaustive filename search; no `single-product.php`, `cart.php`, or `my-account/` overrides exist (the React app-shell owns those routes instead, per `inc/account-redirect.php`). |
| **Purpose** | Minimal — the theme's own docs (`ARCHITECTURE_PROPOSAL.md` §18) already describe most customer-facing surfaces as React app-shell islands, not server-rendered PHP; this finding confirms that's true in practice, not just in plan, for shop/checkout specifically. |
| **V3 replacement** | Retired entirely under ADR-001 — WooCommerce's whole template layer goes away with WooCommerce itself; the receipt template's business logic (real Jalali dates, Persian digits, discount/fee line items) is already classified BUSINESS-RULE EXTRACTION in `V3_MIGRATION_MATRIX.md`'s Commerce section (Receipt presentation row). |
| **Migration complexity** | **Low** — smallest category in the whole migration. |
| **Priority** | Phase 2-3, alongside commerce-service. |

---

## Summary

The exit is smaller in code-volume than "leaving WordPress" sounds: **34 of roughly 38 total data structures (CPTs + custom tables) are already relational tables with zero CPT/postmeta coupling**, and the REST API layer (27 controllers) is already disciplined and close to framework-agnostic in its contract shape. The two categories carrying real migration risk are narrow and already identified: **(a)** the 4-CPT re-platform to real tables (§2, Phase 1, highest priority because it's both highest-risk and highest-traffic), and **(b)** the `beauclick/booking/after_create` pricing pipeline's implicit-priority-ordering becoming an explicit contract inside commerce-service's pricing engine (§6, `V3_ARCHITECTURE_PLAN.md` §2). Everything else — cron, hooks, roles, admin pages, media — is mechanical translation work with a well-understood target shape, not open architectural risk.
