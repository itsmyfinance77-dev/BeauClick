# V3 Gap Register

Status: Phase 2 output. Every item below was independently confirmed against V2.3.0 source/tests by the domain-discovery pass — this is not a re-statement of `docs/roadmap/PRODUCT_GAP_REGISTER.md`, though it draws on it and corrects it in one place (see AUTH note below on that document's own staleness).

Classification: **REQUIRED** (must be resolved before V3 can be considered done for that domain), **RECOMMENDED** (should be fixed, real but not launch-blocking), **OPTIONAL** (nice-to-have, evidence-gated), **DEFERRED** (explicitly out of scope, tracked so it isn't silently lost).

---

## REQUIRED

| ID | Gap | Domain | Evidence |
|---|---|---|---|
| GAP-01 | Ledger append-only guarantee is application-convention only — no DB trigger, revoked grant, or constraint prevents an `UPDATE`/`DELETE` on `wp_bc_ledger_entries`. | Financial | Confirmed by full-codebase grep: no mutating method exists in `LedgerService`, but nothing at the schema layer enforces it either. V3's financial-service must add real DB-level enforcement. **PARTIALLY_RESOLVED (V2.4 Step 26 part 2):** a migration adds `BEFORE UPDATE`/`BEFORE DELETE` triggers rejecting any mutation. Disclosed, not silently claimed closed: `CREATE TRIGGER` requires `SUPER`/`log_bin_trust_function_creators=1`, which this project's own dev/test DB users were confirmed (via `SHOW GRANTS`) to lack — the trigger fails to create on such hosts (migration logs this, does not fatal); code-level immutability is the real, always-true guarantee until that hosting precondition is met. See `PRODUCT_GAP_REGISTER.md` §53. |
| GAP-02 | Audit-logging bypass is a recurring bug class, not a one-off — a REST-reachable, capability-gated admin mutation skipping the audit call its wp-admin twin makes has been found and fixed **three separate times** across two plugins (B2B account approve/reject, B2B quote pricing, Loyalty tier/plan/benefit CRUD). One instance is **still open**: `B2BController::set_tiers` has zero audit logging as of `v2.3.0`. **RESOLVED in V2.4 Step 26**: `set_tiers` fixed; a boot-time `RestController::route()` enforcement (`adminGated` requires `auditAction`/`auditExempt`, mirroring the existing missing-`permission_callback` guard) now structurally prevents this recurring, not just this instance — see `PRODUCT_GAP_REGISTER.md` §51. | Admin / cross-cutting | `PRODUCT_GAP_REGISTER.md` lines ~677, 764, 786, 793 (`ADMIN-05/06/07`); confirmed directly in `B2BController.php` — no `audit_log()->record()` call in `set_tiers()`. |
| GAP-03 | Booking→Order creation has no idempotency guard — a re-fired `beauclick/booking/after_create` filter always creates a second, distinct WooCommerce order for the same booking. Currently self-heals only by accident (the second order's `payment_complete()` lands in the "paid but unconfirmable" path and auto-refunds). | Commerce/Payment | `VERSION_2_ARCHITECTURE_PLAN.md:2695`; confirmed in `BookingOrderBridge::create_order_for_booking()` — no dedupe check before `wc_create_order()`. **RESOLVED (V2.4 Step 26 part 2):** the method now checks `wp_bc_bookings.wc_order_id` and returns the existing order if already set. Fixing this surfaced that `cancel_booking()`'s existing FIN-02 refund safety net now correctly reaches a booking's real linked order in a two-order edge case it previously didn't (the old bug's stale `wc_order_id` had been masking this) — a stronger guarantee, not a regression. See `PRODUCT_GAP_REGISTER.md` §53. |
| GAP-04 | Campaign usage-cap enforcement (`usage_limit_total`/`usage_limit_per_customer`) has a confirmed, open TOCTOU race — the eligibility check and the usage-record insert are not atomic across different bookings under real concurrent load. | Campaign | `PRODUCT_GAP_REGISTER.md:792` (`CAMP-03`), open/unfixed. **RESOLVED (V2.4 Step 26 part 2):** `CampaignService::record_usage_within_cap()`, a single atomic `INSERT ... SELECT ... WHERE` statement, wired into `CampaignDiscount::apply()` in place of the plain `record_usage()` call. Empirically verified under genuine multi-process concurrent load (real separate MySQL connections racing the same cap) to never overshoot. See `PRODUCT_GAP_REGISTER.md` §53. |
| GAP-05 | Financial cross-professional isolation is enforced only at the REST controller boundary (`MyFinanceController`), not at `LedgerService`'s own data-access layer — a future caller that reaches `LedgerService` without going through the gated controller would not be isolated by the service itself. | Financial | Confirmed by reading every public method on `LedgerService` — no row-level access control exists independent of caller discipline. **RESOLVED (post-v2.4.0):** `LedgerService::receivable_net_for_current_session()` and `SettlementService::my_party_summary()`/`my_outstanding_orders()` resolve the party identity entirely internally, accepting no caller-supplied party argument at all; `MyFinanceController` migrated to use them, so the isolation guarantee now lives on the data-access classes, not only the REST boundary. See `PRODUCT_GAP_REGISTER.md` §57. |
| GAP-06 | No real payment gateway is configured or integrated in any environment — `ZARINPAL_MERCHANT_ID` is always empty; only a dev-only, environment-gated Cash-on-Delivery stand-in has ever been exercised. | Payment | `.env.example:29`; `PRODUCT_GAP_REGISTER.md:308,443`. Explicit precondition for a real V3 launch, not merely a code gap. |
| GAP-07 | No formal event contract exists anywhere. `beauclick/*` action hooks are plain, unversioned WordPress `do_action()` calls with zero production subscribers in at least one case (`otp_generated`); the separate `wp_bc_events` analytics table has a free-text `event_type` string and an unvalidated `meta` JSON blob, documented only in a code comment — no schema, no versioning, no producer/consumer registry. | Cross-cutting (Phase 11) | Confirmed by direct inspection of `EventLogger.php` and every `do_action('beauclick/...')` call site across all 10 plugins researched. See `V3_EVENT_CATALOG.md`. **PARTIALLY_RESOLVED (V2.4 Step 25):** the `wp_bc_events`/`event_type` half only — real PHP `EventLogger::EVENT_TYPES` constants replace the docblock-only list, plus a soft `WP_DEBUG`-only `_doing_it_wrong()` notice for an unregistered type (never blocking the write). Deliberately smaller than this row's own full scope: no versioning, no `meta` schema validation, no producer/consumer registry, and the `beauclick/*` `do_action()` hook contract (the OTHER half of this row) is untouched. See `PRODUCT_GAP_REGISTER.md` §56. |
| GAP-08 | The shared ownership-check helper (`RestController::require_owner_or_capability()`) is dead code — defined but never called anywhere in the codebase, because most real ownership relationships are indirect (booking→provider→user, not booking→user directly) and the helper doesn't support that indirection. Every domain reimplements its own inline gate instead. **CORRECTION (V2.4 Step 26 re-audit):** the "dead code, zero call sites" claim was stale/incorrect — a fresh grep found 4 real call sites (`WaitlistController`, `JourneyController`, `MyProfileController`, `ReceiptController`), all direct-ownership. The actual, narrower gap (indirect ownership unsupported) was real and is **RESOLVED**: an optional `$owner_resolver` parameter added, `BookingController`'s two confirmed indirect cases migrated to it. See `PRODUCT_GAP_REGISTER.md` §51. | Authorization / cross-cutting | Confirmed by grep across every plugin extending `RestController` — zero call sites. |
| GAP-09 | SEO was not covered by this Phase 2 discovery pass at all — no agent was scoped to investigate meta tags, structured data/JSON-LD, sitemaps, canonical URLs, or Persian-slug SEO behavior. | SEO | Self-identified gap in this discovery process, not a finding about the code. Required before `V3_ARCHITECTURE_PLAN.md`'s service boundaries can be considered final for provider-service/frontend. |
| GAP-10 | Every business-tunable numeric policy across the platform is explicitly provisional, not a settled business decision: OTP timings (120s expiry, 5 max attempts, 60s cooldown), booking hold window (15 min) and concurrent-hold cap (5), max reschedules (2) and minimum notice (6hr), rebooking interval (30 days), retention inactivity window (60 days), commission rate (15%), loyalty point values (10/booking, 5/review, 10/shop-order), referral reward split (50/50). | Cross-cutting | Every one of these constants carries an explicit `NEEDS_BUSINESS_DECISION` marker or equivalent docblock language in its own source file. V3 must not silently re-adopt these as final requirements — they need a real business sign-off pass. |
| GAP-29 | **Beauty Journey** (`beauclick-journey` plugin — customer beauty profile, goals, timeline; own DB tables `wp_bc_beauty_profiles`/`wp_bc_beauty_goals`; own REST controller, 7 routes) had no V3 service-boundary assignment anywhere in the original discovery document set — absent from `V3_ARCHITECTURE_PLAN.md` §1's 12-service list, `V3_MIGRATION_MATRIX.md`'s domain breakdown, and `V3_API_CONTRACTS.md`'s route inventory, despite being a real, fully-built, self-contained domain. **RESOLVED (Phase 0 blueprint, 2026-08-20):** this task's own required-domain list names `journey` as a top-level domain, separate from `ai` — settling the question by explicit direction rather than by the independent evidence-based review this row's original preliminary recommendation (fold into ai-service) said it needed. Journey is now a standalone module in `V3_DOMAIN_BOUNDARIES.md`, retaining its one real external coupling — `JourneyContextProvider::infer_ai_defaults()` / its V3 successor `journey.inferAiDefaults()` — as an internal cross-module API call into ai-service, not a merge. Not re-opened as a live question; flagged once here so a future reader understands why the final placement differs from the original preliminary recommendation. | Beauty Journey (cross-cutting w/ AI) | Original finding: direct read of `wordpress/wp-content/plugins/beauclick-journey/src/{Context,Goals,Profile,Rest,Timeline}` — self-scoped REST routes, 2 dedicated tables, zero direct table access from other plugins. Resolution: `V3_DOMAIN_BOUNDARIES.md`'s `journey` section, `V3_IMPLEMENTATION_ROADMAP.md` Phase 3. |

## RECOMMENDED

| ID | Gap | Domain | Evidence |
|---|---|---|---|
| GAP-11 | AI/SMS provider adapters are built and tested but have **never been exercised against a real external API** in any environment — `BC_AI_API_KEY`/`BC_SMS_PROVIDER` are unset everywhere this project has run. The safe-fallback design means this hasn't blocked feature testing, but it means the real-provider code path itself is unverified. | AI, Notifications, Auth | `PRODUCT_GAP_REGISTER.md:190` (AI-02), `:85` (AUTH-04). |
| GAP-12 | AI conversation model is one-thread-per-tenant with no history/list concept, for both customer mode (`UNIQUE(user_id)`) and professional mode (`UNIQUE(provider_id)`). This was a deliberate V2 scope-narrowing choice, not a design goal. | AI | `PRODUCT_GAP_REGISTER.md:675` (AI-06); confirmed still true in both migration files. |
| GAP-13 | Business staff model is a single flat "staff" role wired into only 2 of 5+ ownership-gated surfaces (CRM, own-analytics) — not booking confirm/cancel/reschedule, not review responses, not service management. | Provider/Booking | `PRODUCT_GAP_REGISTER.md:653` (PROF-07), confirmed "PARTIALLY_IMPLEMENTED" is still accurate. |
| GAP-14 | Search is plain, unbounded `LIKE '%term%'` — no fuzzy/typo-tolerant matching, explicitly an accepted-at-the-time tradeoff rather than an oversight. V3's move to OpenSearch is a genuine improvement, not merely a port, so this "gap" mostly resolves itself — flagged here so the OpenSearch design is evaluated against the real V2 baseline rather than assumed to already be good. | Search | `PRODUCT_GAP_REGISTER.md:151` (MKT-02), `:802`. |
| GAP-15 | Ranking signal collection has one confirmed schema inconsistency: the `profile_view` event logs `entity_type` as the raw CPT post type (`bc_professional`/`bc_business`) instead of the normalized `'provider'` value every other provider-scoped event type uses — deliberately left as-is in V2 under a "don't change existing event-logging shape" rule, but should not be carried into a V3 rebuild with a clean slate. | Booking/Search | Confirmed in `SignalCollector.php`. |
| GAP-16 | `RankingEngine::recompute_all()` and `CrmService::list_customers()` both do unbatched, in-memory work (a full-table cron sweep; PHP-side search/filter/pagination over an already-fetched result set) — acceptable at V2's current provider/customer-count scale, explicitly flagged in their own docblocks as needing revisiting if scale grows. | Booking | Confirmed in `RankingEngine.php`, `CrmService.php`. |
| GAP-17 | No in-app notification center (bell/unread count) exists — only a backend delivery-history list. | Notifications | `PRODUCT_GAP_REGISTER.md:181` (NOTIF-04). |
| GAP-18 | No automated payout/disbursement, no full double-entry accounting, no B2B/Shop-order settlement — all explicit, disclosed V2 scope exclusions, not oversights. | Financial | `VERSION_2_ARCHITECTURE_PLAN.md:2507,2711,2729`. |

## OPTIONAL

| ID | Gap | Domain | Evidence |
|---|---|---|---|
| GAP-19 | B2B quote-accept orders and Shop/B2B cart purchases are entirely excluded from Campaign discount eligibility today — closed by construction if the Commerce pricing-engine merge in `V3_ARCHITECTURE_PLAN.md` §2 is adopted, but worth confirming as a real product requirement (is B2B promotional pricing actually wanted?) before investing in it as a launch feature. | Campaign/B2B | `PRODUCT_GAP_REGISTER.md:673,704` (CAMP-02). |
| GAP-20 | No admin UI exists for reviewing/resolving a recorded phone-number conflict (`wp_bc_phone_conflicts.resolved_at` is write-never — the column exists, nothing ever sets it). | Auth | `PRODUCT_GAP_REGISTER.md:91` (AUTH-10). |
| GAP-21 | No deletion cooldown/grace-period timer exists for account deletion — safety today is admin review only, not a "changed your mind" window. Explicitly an open product decision in V2, not an engineering gap. | Privacy | `VERSION_2_ARCHITECTURE_PLAN.md:2153`. |
| GAP-22 | No professional/business self-service data export or deletion exists — customer-only scope today. | Privacy | `VERSION_2_ARCHITECTURE_PLAN.md:2081,2145`. |

## DEFERRED

| ID | Item | Domain | Notes |
|---|---|---|---|
| GAP-23 | Portfolio management (`bc_portfolio_item`) is half-built in V2 — read-only, no upload/create/delete path exists anywhere despite the CPT and admin metabox existing. **Do not port this as-is.** Redesign portfolio management as a real V3 feature from requirements. | Provider | `PRODUCT_GAP_REGISTER.md:100,686` (PROF-03). |
| GAP-24 | No admin UI exists for tuning ranking-algorithm weights — code-level constants only, a deliberate V2.0 scope decision. | Search/Booking | `VERSION_2_ARCHITECTURE_PLAN.md:183`. |
| GAP-25 | No calendar-sync integration (Google Calendar etc.) or live-recurrence availability engine — V2's availability service only ever materializes concrete slot rows via bulk-generate. New scope for V3 if wanted, not a gap being closed. | Booking | `AvailabilityService.php` docblock, cross-referenced architecture doc §8. |
| GAP-26 | Waitlist is deliberately never an auction/reservation system ("a reasonable, testable policy, not a complicated auction"). A future "hold this slot for the top waitlist candidate" feature is new scope requiring a new concurrency primitive, not a natural extension of V2's code. | Booking | `WaitlistMatcher.php` docblock. |
| GAP-27 | Ranking is explicitly a hand-weighted scoring formula, not a trained/ML model. Fine as a V3 baseline (DIRECT REUSE per Migration Matrix); ML-based ranking is new scope if ever wanted. | Search | `RankingConfig.php` docblock. |
| GAP-28 | Referral has no click/share-funnel tracking, only reward-on-qualifying-conversion. By design, not a gap — worth noting only if V3 analytics wants click-through funnel data. | Referral | Confirmed by full read of `ReferralService.php`. |

---

## Addendum — 2026-08-19 discovery pass (V2.4.1 baseline)

This register was originally a Phase 2 output grounded in V2.3.0 (`c505c20`). Re-verified fresh against the current `v2.4.1` baseline (`f30e0d6`, latest release tag) as part of a new architecture-discovery-only pass, per the following method: every `RESOLVED`/`PARTIALLY_RESOLVED` disposition below was re-checked directly against current source (not re-trusted from the prior pass's claim), and the codebase was re-scanned for domains this register's Phase 2 pass might have missed entirely (the same self-critical method that originally produced `GAP-09`).

**Re-confirmed accurate, no changes:** GAP-01 through GAP-08's dispositions (all resolved between V2.3.0 and V2.4.1 per `PRODUCT_GAP_REGISTER.md` §51/§53/§57) were spot-checked against live code — `LedgerService::receivable_net_for_current_session()`, `SettlementService::my_party_summary()`/`my_outstanding_orders()` (GAP-05) confirmed present and matching the documented fix exactly, including the internal `ProviderLookup::for_user()` resolution with zero caller-supplied party argument.

**New finding, this pass:** GAP-29 (Beauty Journey has no V3 service-boundary assignment — see REQUIRED table above). This is the same class of gap as GAP-09 (a real domain nobody scoped a discovery agent to place), just for a different domain, and was found by inventorying `wordpress/wp-content/plugins/` directly (18 plugins present, not the 10 the original Phase 2 pass's "10 parallel architecture-discovery passes" implies were each individually scoped — Journey and Locations both exist as of V2.3.0 but neither has a dedicated top-level entry in `V3_MIGRATION_MATRIX.md`'s section list, though Locations' *content* was in fact covered, folded into the Professional/Business section; Journey's was not covered anywhere).

**GAP-09 (SEO) status — discovery-coverage half now CLOSED.** Direct source inspection of `inc/seo.php` (485 lines) and `inc/sitemap.php` (151 lines) — the only two SEO-bearing files in the codebase — confirms SEO-01 through SEO-04's "Resolved in V2.2 Step 12" claim in `PRODUCT_GAP_REGISTER.md` is accurate: dynamic per-page-type title/description/OG/Twitter tags, explicit canonical with thin-marketplace-combination collapse-up logic, `noindex` for account-only and thin pages, real (never-fabricated) `LocalBusiness`/`BreadcrumbList`/`WebSite`/`Organization` JSON-LD deliberately not duplicating WooCommerce's own shop-page JSON-LD, and a custom bounded sitemap provider for city/specialty query-string marketplace URLs. Full findings: `V3_ARCHITECTURE_DISCOVERY.md` §14. **One item remains genuinely open, not just under-investigated**: whether individual profile-post `post_name` slugs render as UTF-8 Persian or a numeric/percent-encoded fallback was not verified against a live URL in this pass (code-reading alone can't settle it) — a live check, not further code reading, is what would close it. The underlying V3 product/technical decision this section surfaces (whether to introduce pretty city/specialty paths now that WordPress's rewrite-flush-timing risk no longer applies) remains open by design, not by omission.

**Minor baseline note, not a gap**: git tag `v2.3.1` exists between `v2.3.0` and `v2.4.0` (commit `8c50b67`) and is not mentioned in this V3 discovery task's own list of historical tags to leave untouched (`v1.0.0, v1.0.1, v2.0.0, v2.1.0, v2.2.0, v2.3.0, v2.4.0, v2.4.1`). Investigated: it is a real, benign intermediate tag (docs + the entire original V3 discovery doc set + two small AI-provider/auth fixes, `git diff v2.3.0..v2.3.1` confirmed), not a mistake to fix — noted here only so this document set doesn't silently contradict the task's own tag list without explanation.

## Addendum — Phase 0 implementation blueprint (2026-08-20)

This register continues to be updated as the accompanying document set grows from architecture discovery into a Phase 0 implementation blueprint (`V3_PHASE0_BLUEPRINT.md`, `V3_REPOSITORY_STRUCTURE.md`, `V3_DOMAIN_BOUNDARIES.md`, `V3_DATABASE_BLUEPRINT.md`, `V3_API_CONTRACT_BLUEPRINT.md`, `V3_EVENT_ARCHITECTURE.md`, `V3_FRONTEND_ARCHITECTURE.md`, `V3_INFRASTRUCTURE_PLAN.md`, `V3_IMPLEMENTATION_ROADMAP.md`, and `ADR-011` through `ADR-016`). **No code, migration, or repository was created in producing these — still discovery/blueprint output.**

**GAP-29 (Beauty Journey) — now RESOLVED**, per this task's own explicit required-domain list naming `journey` as a standalone domain (see the updated REQUIRED-table row above). This settles the boundary question by direction rather than by the independent evidence review the original finding said it needed — recorded honestly as such, not presented as if a fresh architectural review had reached the same conclusion independently.

**No other gap's status changes in this addendum.** Six items surfaced while writing the blueprint are *not* new gaps in the V2→V3 sense (they're V3-internal design decisions, not V2 findings) and are tracked in their owning documents instead of here: the expand/contract migration discipline being convention-enforced rather than tooling-enforced at launch (`ADR-016`), the hosting-region decision remaining open (`V3_INFRASTRUCTURE_PLAN.md` §1), the `apps/admin` separate-app-vs-route-group question (`V3_FRONTEND_ARCHITECTURE.md` §10), the mobile-first assumption not independently re-verified (`V3_FRONTEND_ARCHITECTURE.md` §8), the Persian-slug `post_name` encoding question carried over unchanged from the prior addendum (still open, still not a live-URL check), and refresh-token-rotation replay-detection's real implementation risk (`ADR-014` consequences).

## Addendum — Phase 1 implementation (identity-service + provider-service foundation, 2026-08-20)

This phase moved from blueprint to real, running, tested code (`v3/` — see `V3_PHASE1_IMPLEMENTATION.md` for the full report). It is **not** a further V2-discovery pass — no new V2 gaps were found or should be expected from it. What it surfaced instead is real implementation risk in the V3 build itself, recorded here so it isn't lost between phases:

1. **A pnpm workspace dependency-duplication bug** — `@nestjs/common`, `@nestjs/core`, and `@nestjs/typeorm` resolved to two separate physical installations across `apps/api` vs `services/identity`/`services/provider`, invisible at typecheck time but breaking dependency injection at runtime (a `DataSource` provided under one copy's token was invisible to `@InjectRepository` decorators compiled against the other). Fixed via `pnpm-workspace.yaml` `overrides`, pinning one version workspace-wide. **Re-verify this whenever a new package is added to any `v3/` package.json** — a new peer-dependency range can silently reintroduce it.
2. **A NestJS/`@nestjs/config` async-module interaction bug** — `JwtModule.registerAsync`/`TypeOrmModule.forRootAsync` with `inject: [ConfigService]` fail to resolve at boot unless `ConfigModule` is also listed in that specific call's own `imports`, even when `ConfigModule` is global. Fixed in both `libs/auth` and `apps/api`. A known NestJS/`@nestjs/config` interaction, not specific to this codebase — worth remembering for every future `registerAsync`/`forRootAsync` call in later phases.
3. **`libs/auth` was carved out of `services/identity` during implementation**, not pre-populated in Phase 0's blueprint — a real Nx module-boundary violation was caught (a `services/*` package importing another `services/*` package directly) and fixed by moving the shared JWT/capability guards into the `libs/auth` directory `V3_REPOSITORY_STRUCTURE.md` had already named but left empty. The blueprint's structure held; this is it working as designed.
4. **No real PostgreSQL server is available in this environment** (confirmed: no `psql`, no Docker, no local Postgres service) — every integration/e2e test in this phase runs against pg-mem (a real in-memory SQL engine, not a mocked repository layer, but not equivalent to real Postgres either). **This is the single highest-priority item before Phase 2**, since financial-service's append-only ledger guarantee (`ADR-009`) specifically depends on real Postgres role-grant behavior pg-mem cannot verify — echoing the exact same class of hosting-precondition risk `GAP-01` already named for V2's own MySQL environment.
5. **RBAC is code-based, not the dynamic `identity.roles`/`identity.capabilities` tables** the database blueprint describes — a deliberate Phase 1 scope reduction (capability-name checks are still the enforcement mechanism everywhere; only the data source is static), not silently substituted for the designed mechanism.
6. **Business entities are out of Phase 1 scope** — only `Professional` was implemented, per this task's own explicit instruction list. `provider.professionals.ownerId` is UNIQUE (one profile per identity), a real constraint that will need revisiting once Business (multi-staff) entities are added in a later phase — flagged now so it isn't rediscovered as a surprise then.

Full detail, including the two real bugs test-writing itself caught (`BeauClickExceptionFilter` mislabeling a 500 as `VALIDATION_ERROR`; two of this phase's own test assertions being wrong, not the application): `V3_PHASE1_IMPLEMENTATION.md` §2, §7, §11.

## Addendum — Phase 1 completion pass (real PostgreSQL + frontend, 2026-08-20)

Closes the four items the initial Phase 1 addendum left open, and materially changes the status of one long-standing V2-era gap.

**`GAP-01` (ledger append-only guarantee) — the infrastructure contract is now PROVEN ENFORCEABLE, though financial-service itself is still unbuilt.** V2's own attempt could only ever be application-convention plus a trigger that silently failed to install on hosts lacking `SUPER`/`log_bin_trust_function_creators` (`PRODUCT_GAP_REGISTER.md` §53). On real PostgreSQL 16, a **non-superuser** role granted `INSERT`+`SELECT` and nothing else has `UPDATE`, `DELETE`, and `TRUNCATE` all rejected with `permission denied`, with the row verified byte-identical afterwards (`database/scripts/financial-role-contract.sql`, automated in `apps/api/test/financial-role-contract.pg-spec.ts`, which asserts `usesuper = false` so the test can't pass by privilege). This does **not** close GAP-01 — closing it requires financial-service to actually exist and use these roles (Phase 2) — but it removes the hosting-capability doubt that made GAP-01 unresolvable in V2, and it is verified rather than assumed.

**Item 4 of the previous addendum (no real PostgreSQL) — CLOSED.** PostgreSQL 16.15 installed; migrations run from zero, schema inspected directly via `psql`, constraints exercised with real SQL, re-run confirmed idempotent; a 26-test real-database integration suite now runs alongside (not instead of) the fast pg-mem layer.

**This surfaced three real bugs that pg-mem had structurally hidden** — recorded because the *class* of bug matters for every future phase, not just these three instances. pg-mem generated its own schema from entity metadata rather than executing the real migration SQL, so any entity↔migration divergence was invisible by construction:
1. TypeORM's default **camelCase** column naming never matched the migrations' **snake_case** columns. Fixed with `SnakeNamingStrategy` at *both* DataSource construction sites, so the fast test layer now matches real Postgres instead of diverging from it.
2. Two hand-written raw SQL fragments hardcoded quoted camelCase identifiers (which a naming strategy cannot rewrite) — `OtpService`'s atomic consume-on-success and `TokenService`'s revoke-all.
3. An explicit `@JoinColumn({name:'cityId'})` silently **overrode** the naming strategy. Caught by the new real-Postgres suite only after 1–2 were fixed.
**Standing lesson for Phase 2+:** a passing pg-mem suite is not evidence that migrations and entities agree. Any phase that adds a migration must run the real-Postgres suite before claiming its schema works.

**A fourth real bug — CORS was entirely unconfigured on the API**, so every browser call from the frontend origin failed at preflight. Found only by driving a real browser against the real stack. Fixed with an explicit origin allow-list (never a wildcard), verified by confirming an untrusted origin receives no allow-origin header. **Lesson:** API-only testing (supertest/curl) cannot surface browser-enforced policy; live browser verification is not redundant with e2e tests.

**Items 1–3 of the previous addendum remain accurate and unchanged**: the pnpm duplicate-install hazard (re-verify `pnpm-workspace.yaml` `overrides` when adding packages), the `@nestjs/config` async-module `imports:[ConfigModule]` requirement, and `libs/auth` having been carved out of `services/identity`. A related **test-hermeticity defect** was also found and fixed this pass: Nx auto-loads a project's `.env` into `process.env`, and `@nestjs/config` reads `process.env` **before** `load()` (with `ignoreEnvVars` not gating that path), so the suite passed under bare `jest` and failed under `nx run api:test` on identical code. The test factory now sets its own environment explicitly rather than depending on library-flag semantics.

**Module-boundary enforcement (previous addendum item 5) — CLOSED**: `@nx/eslint-plugin`'s `enforce-module-boundaries` with scope tags, verified by deliberate violation in both directions (provider→identity and identity→provider both fail lint), not merely configured.

**Still open after this pass** (full detail in `V3_PHASE1_IMPLEMENTATION.md` §15.7): refresh-token-in-memory (a page reload signs the user out — deliberate, pending an httpOnly cookie in Phase 2); RBAC data still code-based rather than the dynamic tables; audit logging still logger-based rather than DB-persisted/structurally enforced (Phase 4); Business entities out of scope; no CI pipeline wired yet; and the PostgreSQL instance is a disposable dev one, so `V3_INFRASTRUCTURE_PLAN.md` §1's hosting decision remains the open blocker it always was.

## Note on trusting the existing gap register

`docs/roadmap/PRODUCT_GAP_REGISTER.md` is itself confirmed to contain at least one **stale** entry: it lists rescheduling (BOOK-03) as `MISSING` in one section while a later section of the *same document*, and the actual shipped code (`RescheduleService`, full REST routes, full test coverage), show it's been complete since V2.2 Step 15. This is not a criticism of that document — it's an accurate historical log of a point-in-time audit — but it means **the register must be read as a timeline, not a live dashboard**, and every item this V3 Gap Register cites from it was independently re-verified against current source before being carried forward here.

---

# Phase 2 addendum (2026-08-20) — Booking + Commerce + Payment + Financial

Status changes from the Phase 2 implementation pass. Every "CLOSED" below is backed by a test that runs against a real PostgreSQL 16 server; nothing here is closed on the strength of application convention.

## Closed

**`GAP-01` — ledger append-only guarantee — CLOSED.**
Phase 1 proved the *contract* was enforceable on a stand-in table. Phase 2 makes it true of the real ledger. `financial.ledger_entries`, `settlement_batches`, and `settlement_items` are owned by `beauclick_financial_owner` (a NOLOGIN role the application does not have); financial-service connects as `beauclick_financial_writer` with `INSERT` + `SELECT` only; `UPDATE`/`DELETE`/`TRUNCATE` are granted to no application role. The **main application role has `REVOKE ALL ON SCHEMA financial`** and cannot even `SELECT` the ledger — stronger than the blueprint required. Because the application role is not the owner, it cannot grant itself back what was revoked.

Verified in `apps/api/test/financial-integrity.pg-spec.ts`: every mutation denied, rows re-read and confirmed byte-identical afterwards, and the connecting role asserted `usesuper = false` so the result cannot pass for the wrong reason. The one deliberate exception — `UPDATE` on `financial.outbox_events`, which holds delivery receipts rather than financial facts — is asserted explicitly rather than left implicit.

*Residual:* verified on a local PostgreSQL 16 instance. A managed provider must be re-verified with `database/scripts/financial-roles.sql` before production relies on it. The *capability* doubt is gone; a specific host's behaviour is still a specific host's behaviour.

**`GAP-03` — booking→order double creation — CLOSED.**
`uq_orders_source` on `(source_type, source_id)` makes a second authoritative order for one booking impossible at the storage layer. V2's guard "self-healed only by accident"; this one cannot fail to hold. Booking and order are additionally created in ONE transaction, so neither can exist without the other.

**`GAP-05` — financial party isolation — CLOSED, structurally.**
The session-facing API (`MyFinanceService`) takes a **session user id and nothing else**. There is no party argument to spoof, mistype, or forget to validate; the party is resolved internally through a port. Cross-party reads live on a separate, capability-gated admin service, so the dangerous shape is never one typo away from the self-service one. Nine isolation tests, including the adversarial-no-leak harness asserting another professional's distinguishable figure appears nowhere in the response payload.

**`FIN-02` (V2 carry-over) — cancellation did not refund a paid booking — CLOSED by construction.**
The refund is now a consequence of the `BookingCancelled` event itself, so no future cancellation path can be added that forgets it.

## Still open

**`GAP-06` — a real Iranian payment gateway — OPEN.**
Unchanged in substance, but the surrounding work is done. The provider abstraction, registry, and a production-gated local mock gateway are built and verified (23 callback-security tests plus a real browser round trip). A real adapter was deliberately **not** shipped: no merchant credentials exist in this environment, and an adapter whose money-unit and field semantics were never exercised against the live API is a liability rather than an asset. Remaining work is one adapter against a known-good interface; commerce, booking, financial, and every controller are untouched by adding it.

**`GAP-10`** (OTP tuning), **`GAP-12`** (AI conversation cardinality), **`GAP-18`** (automated payout), **`GAP-29`** (Journey boundary) — unchanged, all out of Phase 2 scope. Note that `GAP-18`'s natural integration point now exists: settlement is built, append-only, and idempotent, so automated payout is additive within it rather than a parallel system.

## New findings from this phase

**PHASE2-01 — pg-mem does not honour TypeORM's `ROLLBACK`.**
Probed directly: a row written inside a transaction that throws is still present afterwards, where real PostgreSQL leaves zero rows. **Consequence: no test on the fast layer can prove anything about atomicity, isolation, or locking.** Phase 1's suite was not wrong about what it did assert, but it gave zero signal about transactional behaviour — and Phase 2's correctness rests almost entirely on that. Every such assertion now runs against real PostgreSQL. Documented in `libs/testing/src/in-memory-data-source.ts` so it cannot be rediscovered the hard way.

**PHASE2-02 — the migration runner ordered by schema directory, not timestamp.**
Phase 1 code. Adding a `booking/` schema would have applied every booking migration before every identity migration purely because `'b' < 'i'`, silently reordering the deployment history the timestamp prefixes exist to define. Harmless while no cross-schema dependency existed; it would first surface at the worst possible time. Fixed.

**PHASE2-03 — `financial-role-contract.sql` was never committed.**
The repo-root `*.sql` ignore rule swallowed it and `v3/.gitignore` un-ignored only `database/migrations/`. A guarantee documented in `V3_PHASE1_IMPLEMENTATION.md` §15.2 and exercised by a passing spec existed only on the machine that ran it. Fixed, with `database/scripts/*.sql` un-ignored.

**PHASE2-04 — a retried checkout opened a second live gateway attempt.**
Found by driving the real flow in a real browser, not by any unit test. Two live gateway references for one payment intent are two separately-chargeable transactions, and the second charge would have been silently absorbed. Closed at three levels: `initiate()` reuses a live attempt; a partial unique index makes a second one unrepresentable; and a genuinely-new payment landing on an already-paid order is now detected as a duplicate charge and refunded rather than absorbed. See `V3_PHASE2_IMPLEMENTATION.md` §5.2.

**PHASE2-05 — `@Redirect()` routes were incompatible with the response envelope.**
The global interceptor wrapped Nest's redirect control object, so the payment gateway's return leg silently degraded to a 302 with no location. Fixed with an explicit `@SkipResponseEnvelope()` decorator rather than shape-sniffing for a `url` field, which would also un-envelope a legitimate DTO.

**PHASE2-06 — header nav touch targets were 25px.**
Phase 1 code, below the 44px baseline that phase set for itself. Measured at 375px during live QA rather than eyeballed. Fixed.

## Carried forward, unresolved

**The httpOnly refresh cookie was named Phase 2 scope in `V3_PHASE1_IMPLEMENTATION.md` §15.7 and was NOT done.** Booking, commerce, payment, and financial consumed this phase. A page reload still signs the user out. Restated as open rather than quietly dropped.

---

# Phase 3 addendum (2026-08-21)

## Closed in Phase 3

**`GAP-14` (search is unbounded `LIKE '%term%'`) — CLOSED.** Replaced by a real
OpenSearch read model with a Persian analyzer chain verified against a live
OpenSearch 2.19.1 instance: Arabic↔Persian letter folding, ZWNJ removal,
Persian and Arabic-Indic digit folding, fuzzy typo tolerance with transpositions,
and edge-ngram autocomplete with a non-expanding search analyzer. Note this is a
genuine capability change, not a re-platform of the same limitation — see ADR-021.

**`GAP-15` (`profile_view` logs the raw CPT type) — CLOSED STRUCTURALLY.** The
`ProviderProfileViewed` contract types `entityType` as `z.literal('provider')`, and
`analytics.events` carries a CHECK constraint making any un-normalized subject type
unstorable. The inconsistency is now unrepresentable rather than merely corrected.

**`GAP-17` (no in-app notification center) — CLOSED.** A real notification centre
with list, unread count, mark-read, mark-all-read, deep links, pagination,
per-category preferences, and cross-user denial. Verified in a browser.

**`GAP-29` (Beauty Journey has no V3 boundary) — CLOSED ON EVIDENCE.** The row
previously recorded that the placement was settled *by direction* rather than by the
evidence review its own preliminary recommendation asked for. ADR-019 performs that
review and confirms the standalone placement, on the strength of a specific artifact
(`beauty_profiles.notes`) rather than assertion.

**Phase 2 carry-over: httpOnly refresh cookie — CLOSED.** ADR-020. A page reload now
keeps the session, verified in a real browser, with no long-lived credential readable
by JavaScript.

**Phase 2 carry-over: zero registered pricing rules — CLOSED.** `MembershipDiscountRule`
is the first real rule; verified live at 850,000 → 765,000 with an itemized adjustment
persisted on the order.

**Phase 2 carry-over: no CI pipeline — CLOSED (authored).** `.github/workflows/v3-ci.yml`
runs the same commands a developer runs, against ephemeral PostgreSQL and OpenSearch
containers, and **fails if any suite silently skips**. Disclosed honestly: this
repository has no configured remote runner, so the workflow has never executed on CI
infrastructure. Every command in it was run locally.

## Re-evaluated, deliberately NOT closed

**Kafka (ADR-007's named transport) — DEFERRED ON EVIDENCE.** §24 asked for an
evaluation rather than an automatic adoption. `OrderPaid` now fans out to five
independent consumers and runs correctly on the in-process relay. See ADR-022 Part 1
for what would change the answer.

**ClickHouse (roadmap's named analytics store) — NOT ADOPTED.** V3 does not have more
data than V2 did. See ADR-022 Part 2 for what was taken from the columnar design
anyway, and for the migration path that stays open.

## Still open, unchanged

**`GAP-06`** (no real payment gateway) — no merchant credentials exist in this
environment. Untouched by this phase.

**`GAP-11`** (AI/SMS providers never exercised against a real API) — still true for
SMS and email. Phase 3 ships a real channel abstraction with logging providers behind
it, and reports `providerVerified: false` through the admin API so a channel that
quietly logs can never be mistaken for one that delivers.

**`GAP-10`** (provisional numeric policy) — carried forward deliberately and made
*visible*: every loyalty value is environment-configurable and
`GET /v1/admin/loyalty/policy` reports which are still running on V2's placeholders.
The tier qualification basis is likewise configurable, with `rolling_365` genuinely
implemented rather than merely named.

**`GAP-12`** (AI conversation cardinality), **`GAP-13`** (flat staff model),
**`GAP-16`** (unbatched ranking recompute — now moot for search, since scoring is
per-event rather than a full-table sweep, but `CrmService` is untouched),
**`GAP-18`** (automated payout), **`GAP-19`**–**`GAP-28`** — all unchanged and out of
Phase 3 scope.

## New finding, this phase

**No review domain exists in V3.** Ranking's rating signal, the `minRating` filter,
and the rating sort are all built and correct, but no producer populates
`ratingAvg`/`reviewCount` — they are permanently 0/0 until reviews ship. The scoring
formula handles that through its existing no-evidence path (the Bayesian term collapses
to the platform mean; cold-start blending pulls toward neutral), so nothing is faked
and nothing is penalised. Recorded here because a reader seeing a rating filter in the
API could reasonably assume there is rating data behind it.

---

# Phase 4 addendum (2026-08-22) — Business/Seller, Waitlist, Financial Outbox

## Closed in Phase 4

**Business seller party — CLOSED.** See ADR-023. `services/business` is real,
tested code: self-service business creation, a consent-gated staff roster, and
`SellerPartyLookup` as the single place order creation and financial-party
resolution agree on whether a professional's earnings belong to them or to a
business they are actively affiliated with.

**Waitlist — CLOSED.** See ADR-024. GAP-26's invariant ("offer, never reserve")
is carried forward unchanged and, unlike V2, is now proven against real
concurrency rather than only asserted: a waitlist `accept()` and a competing
direct customer's booking attempt, fired with no `await` between them against
real PostgreSQL, resolve to exactly one booking.

**Financial outbox consumer — CLOSED.** See ADR-025. A second `OutboxRelay`
instance, bound to `FINANCIAL_DATA_SOURCE`, drains `LedgerEntriesRecorded`,
`SettlementRecorded`, and `SettlementReversed` into analytics facts and a real
seller notification. This is the only path financial data can leave
`services/financial` at all, since the main application role structurally
cannot `SELECT` that schema (ADR-017).

**`GAP-13`** (flat staff model) — **partially closed.** Business staff now has
real roles (owner/manager/staff) with distinct capabilities, but this is
`business_staff`, a separate table from `provider.professionals` — an
independent professional (no business) still has no internal staff concept of
their own. The gap's *product* concern (can a provider delegate access to
someone else) is addressed for business-affiliated professionals; an
independent solo professional's own delegation story is unchanged.

## New findings, this phase

**PHASE4-01 — CI has a real GitHub Actions runner and has been failing on every
push since Phase 3's workflow was authored.** Phase 3's own report states "this
repository has no configured remote runner, so the workflow has never executed
on CI infrastructure" — untrue at the time it was written and never
re-verified since. The real-Postgres job failed at progressively deeper points
as each blocking bug was fixed in this phase: a pnpm-version lockfile mismatch,
pnpm 11 requiring Node ≥22.13, `ts-node` never declared where the root
`migrate` script actually needed it, `financial-roles.sql` assuming
`public.schema_migrations` already existed, PostgreSQL 15+'s removal of the
default `CREATE`-on-`public` grant, and a genuine missing DI binding
(`WaitlistProfessionalResolver`'s port was declared but never bound) that
broke the entire application boot for every real-Postgres suite. See
V3_PHASE4_IMPLEMENTATION.md §16 for the full, ordered account and final
outcome.

**PHASE4-02 — `financial-role-contract.pg-spec.ts` (a Phase 1 artifact) targets
a `financial_contract_check` schema the CI workflow's provisioning step never
creates, and its OWN setup script is actively unsafe to add to that same
provisioning step.** Found only because this is the first time CI ran far
enough to reach it. Investigated further, not just left as a missing-table
error: `database/scripts/financial-role-contract.sql` (this test's real
prerequisite) begins with `DROP ROLE IF EXISTS beauclick_financial_writer;
DROP ROLE IF EXISTS beauclick_financial_reader;` — the SAME role names
`database/scripts/financial-roles.sql` (the real, CI-provisioned script) also
creates. Running both in the same database, in either order, means one
script's `DROP ROLE` would tear down the other's roles mid-CI-run — a real
collision, not a hypothetical one, and confirmation that this script was
built for a standalone, disposable verification environment (its own docblock:
"proves the INFRASTRUCTURE CONTRACT... before Phase 2 commits to it" —
written when financial-service itself did not exist yet) and was never meant
to coexist with the real financial-roles.sql. The guarantee this test was
written to prove (GAP-01) is independently and completely proven for real by
`financial-integrity.pg-spec.ts` against the actual `financial` schema.
Deliberately NOT fixed by this phase: renaming the roles or giving this test
its own isolated database is a real, low-but-nonzero-risk change to a
pre-existing test's own infrastructure, and deciding whether it should
instead simply be deleted (now redundant) is a product/test-strategy call,
not an engineering oversight to quietly patch around a role-collision
landmine.

**PHASE4-03 — PostgreSQL 15+'s revoked default `public` schema `CREATE` grant
is a real hosting consideration for production, not only a CI fixture.** Any
managed PostgreSQL provider defaulting to 15+ (most now do) needs the
application role explicitly granted `CREATE ON SCHEMA public` — this was
invisible until a genuinely fresh database was provisioned, which V3's own
disposable dev-database habit (Phase 1: "beauclick_v3_dev owned by ...
beauclick_app") never exercised, since `beauclick_app` was made the DATABASE
owner from the start in that flow, which happened to be sufficient there but
is not guaranteed on every hosting provider's own database-creation
convention. Flagged for `V3_INFRASTRUCTURE_PLAN.md`'s hosting decision.

**PHASE4-04 — `BookingService.create()`'s idempotency-key protection had a
real gap under N-way (N>2) concurrent identical retries, found and fixed.**
Also a "first real CI run reaches this for the first time" finding, not a
Phase 4 regression: `booking-lifecycle.pg-spec.ts`'s own pre-existing
"converges on ONE booking under concurrent identical retries" test (4
simultaneous calls, one shared idempotency key) failed twice in a row before
being diagnosed as real, not flaky. The replay check only ran when the
caught error's `.constraint` name matched `'idempotency'` — true only when
the failing transaction itself reached the idempotency-key insert and
collided with an already-committed one. Since only one slot exists, at most
ONE of N concurrent identical requests can ever win `claimSlot()`; every
other one throws `SlotUnavailableException` directly out of `claimSlot()` —
a plain JS exception carrying no `.constraint` — without ever reaching the
insert whose collision the check was watching for. Those callers received no
idempotency protection: a losing retry using the exact key the winner used
was told the slot was gone, instead of being handed the winner's own
booking. Fixed by widening WHEN the replay check runs (any failure, given a
key), not what it does — `findByIdempotencyKey()` is already scoped to the
exact key string, so it can only ever return the genuine result of that
key's own request. Verified fixed: the same test passes on the next CI run.

## Still open, unchanged

**`GAP-06`** (no real payment gateway), **`GAP-10`** (provisional numeric
policy), **`GAP-11`** (AI/SMS providers never exercised against a real API),
**`GAP-12`** (AI conversation cardinality), **`GAP-18`** (automated payout),
**`GAP-19`**–**`GAP-28`** — all unchanged and out of Phase 4 scope. RBAC
remains code-based (`identity.users.roles` is still never populated
dynamically for `professional`/`business`/either — both remain answered
entirely by row ownership, exactly as Phase 1 designed); audit logging remains
structured-logger-based, not DB-persisted. Hosting-specific PostgreSQL grants
remain verified only against a CI-provisioned ephemeral database and the
finding in PHASE4-03 above — never a real target hosting provider.

---

# Phase 5 addendum (2026-08-22) — Release audit, v3.0.0 readiness

Full findings, the complete gap reconciliation table, and the release-gate
reasoning live in `V3_RELEASE_AUDIT.md`. **Release decision: V3 RELEASE
BLOCKED — PAYMENT CONFIGURATION REQUIRED.** No `v3.0.0` tag created. Summary
of what changed in this register specifically:

**`PHASE4-02` — CLOSED this phase.** `financial-role-contract.pg-spec.ts`
and its setup script were deleted after confirming (not assuming) the
collision risk: the script's own `DROP ROLE IF EXISTS
beauclick_financial_writer/reader` targets the identical role names the
real, CI-provisioned `financial-roles.sql` creates. The one piece of unique
coverage it had (the read-only role's grants) was found already written,
dormant, inside `financial-integrity.pg-spec.ts:161` — gated on
`TEST_FINANCIAL_READER_URL`, which CI had simply never set despite the role
already being provisioned with a known password. Wired it in. Net effect:
one previously-dormant real assertion now runs against the real ledger; the
stand-in table and its role-collision hazard are gone.

**`GAP-06` — re-confirmed OPEN, and re-classified as RELEASE-BLOCKING.**
Not a new finding, but a new determination: this phase investigated whether
real payment is a *stated mandatory* V3 capability (it is, per this
register's own GAP-06 wording — "explicit precondition for a real V3
launch" — and per `V3_IMPLEMENTATION_ROADMAP.md`'s own Phase 2 acceptance
criteria, which requires the core loop to run "against a real (even
sandbox) payment gateway"). Confirmed still unsatisfied in every respect:
`PAYMENT_DEFAULT_PROVIDER=mock`, no gateway credential of any kind in
`.env` or `.env.example`, `MockGatewayProvider` the only registered
`PaymentProvider`. This is the sole release blocker.

**PHASE5-01 — a real, minor accessibility bug found and fixed.** The
homepage's only interactive element (`apps/web/app/page.tsx`'s `/auth`
link) had no touch-target sizing at all — 21×135px, under the 44px minimum
this codebase's own `Button` component already enforces, and the same
class of bug `PHASE2-06` already caught once. Fixed to match `Button`'s own
convention; verified in a real browser, zero overflow introduced.

**PHASE5-02 — a real gap found, deliberately NOT fixed this phase.**
`ThrottlerModule` is registered (`services/identity/src/identity.module.ts`)
but its guard was never wired to `APP_GUARD` — no route anywhere gets
generic per-IP flood protection from it. Investigated for a same-session
fix and declined: `ThrottlerGuard` rate-limits per requester IP, and every
real-Postgres test file shares ONE Nest application instance (and
therefore one throttle bucket) across dozens of `it()` blocks — wiring a
global guard in without first adding a test-environment bypass (the same
shape as the existing `DISABLE_BACKGROUND_SWEEPS` escape hatch) risked
tripping false 429s across the exact 342-test-green suite this audit relies
on as its own evidence. The actually security-critical surface — OTP
request flooding, the unauthenticated entry point — already has its own
dedicated, tested, always-enforced limiter, independent of this unused
generic one. A safe fix requires the test-harness bypass to exist first;
recorded here rather than either silently fixed or silently ignored.

**Hosting grants — still unverified against a real target provider.** This
phase additionally confirmed the local native PostgreSQL install's
credentials in `.env` are stale (`password authentication failed`) and
that Docker Desktop, though installed, did not start when launched in this
environment (attempted; no process appeared after 10 minutes) — so CI's
ephemeral container remains the only real-PostgreSQL verification available
in this environment, exactly as Phase 4 recorded.

**Everything else in this register is unchanged** — every GAP-19 through
GAP-28 item, GAP-09/12/16/18's deferrals, and GAP-10's provisional-policy
status all stand exactly as Phase 4 left them, re-confirmed rather than
re-litigated.

---

# Phase 5 addendum II (2026-08-22) — GAP-06 split into two halves

`GAP-06` is no longer a single open item. It is now explicitly **two**
items with different statuses, and conflating them again would be the
dishonest move this split exists to prevent:

**`GAP-06a` — SANDBOX PAYMENT LIFECYCLE — IMPLEMENTED AND VERIFIED.**
`SandboxPaymentProvider` (an evolution of the Phase 2 `MockGatewayProvider`,
not a second provider beside it — see `V3_PAYMENT_SANDBOX.md` §1 for why
duplicating it was rejected) implements the same `PaymentProvider` interface
a real adapter will. The full lifecycle is proven against real PostgreSQL in
CI: initiate → redirect → SUCCESS/FAILURE/CANCEL decision → callback →
server-to-server verify → paid → booking confirmed → real ledger entry, plus
refund → real ledger reversal. Evidence: `sandbox-payment-lifecycle.pg-spec.ts`
(24 cases) and the migrated `payment-security.pg-spec.ts` adversarial suite.

What this closes that was genuinely missing before: `cancelled` as an outcome
DISTINCT from `declined` (the old CHECK constraint allowed neither, and the
checkout page conflated both behind one button), the §4 gateway-side data
model (`order_id`, `payment_intent_id`, `currency`, `updated_at`), a decide
endpoint that REFUSES an unrecognised decision instead of defaulting to paid,
and CAS-hardened concurrent refunds.

**`GAP-06b` — REAL PRODUCTION GATEWAY — OPEN / EXTERNAL_CONFIGURATION.**
Unchanged and unchangeable in code. No real Iranian gateway adapter exists,
no merchant credentials exist in this environment, and none were fabricated.
The sandbox does not and cannot substitute for this: it makes no network
call, moves no money, and leaves the money-unit and field semantics of any
actual gateway entirely unexercised — which is precisely the risk a real
adapter must be tested against.

**Release implication — the sandbox does NOT unblock v3.0.0.**
`V3_IMPLEMENTATION_ROADMAP.md`'s Phase 2 acceptance criteria requires the
core loop to run *"against a real (even sandbox) payment gateway"*, and its
own risk note for that phase says to *"budget it as new-feature engineering
with its own sandbox-test cycle"* — i.e. the roadmap treats the sandbox-test
cycle as part of BUILDING the gateway integration, not as a substitute for
having one. A locally-simulated bank is not "a payment gateway" in the sense
that criterion means, and GAP-06's own register wording ("explicit
precondition for a real V3 launch") is about a real gateway, not a
simulator. Reading the sandbox as satisfying the gate would be exactly the
silent policy override Phase 5's brief forbids. **The release gate therefore
still requires an explicit human release-policy decision** — see
`V3_PHASE5_IMPLEMENTATION.md` §9.

**PHASE5-03 — a real outbox lesson, found by CI.** The sandbox refund test
initially asserted a net-zero receivable and got the full un-reversed amount.
Not a product bug: the refund path is a TWO-HOP event chain
(`RefundCompleted` on the payment outbox → `OrderRefunded` on the commerce
outbox → ledger reversal), and a single `relay.drain()` pass scans `commerce`
BEFORE `payment` and fetches each source's pending rows once up front — so
the row hop 1 creates is invisible to the pass that created it. The existing
financial suite never surfaced this because it calls `ledger.recordRefund()`
directly rather than going through the chain. Recorded because the *class* of
mistake ("one drain is enough") will recur for any future multi-hop chain;
fixed with a drain-until-quiet helper rather than a hardcoded second drain.
