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
| GAP-06 | No real payment gateway is configured or integrated in any environment — `ZARINPAL_MERCHANT_ID` is always empty; only a dev-only, environment-gated Cash-on-Delivery stand-in has ever been exercised. | Payment | `.env.example:29`; `PRODUCT_GAP_REGISTER.md:308,443`. Explicit precondition for a real V3 launch, not merely a code gap. **SPLIT — this row is superseded and retained for history only.** See `GAP-06a` (sandbox lifecycle, RESOLVED/VERIFIED) and `GAP-06b` (real production gateway, OPEN/EXTERNAL_CONFIGURATION) in the "Phase 5 addendum II" section below, and the release-policy treatment in `V3_RELEASE_POLICY_EXCEPTIONS.md` (EXC-001). Do **not** read this row's original "precondition for a real V3 launch" wording as still governing the `v3.0.0` tag — it governs **production payment enablement**, which remains blocked. |
| GAP-06a | **Sandbox payment lifecycle** — initiate → redirect → decide → callback → server-side verify → paid → booking confirmed → real ledger entry, plus refund → real ledger reversal. | Payment | **RESOLVED / VERIFIED.** Proven against real PostgreSQL in CI: `sandbox-payment-lifecycle.pg-spec.ts` (20 cases) + `payment-security.pg-spec.ts` (26 cases). Design: `V3_PAYMENT_SANDBOX.md`. Release impact: none. |
| GAP-06b | **Real production payment gateway** — a real Iranian gateway adapter plus real merchant credentials. | Payment | **OPEN / EXTERNAL_CONFIGURATION.** No adapter exists, no credentials exist in this environment, none were fabricated. **Release impact on `v3.0.0`: NON-BLOCKING under the explicit release exception EXC-001** (`V3_RELEASE_POLICY_EXCEPTIONS.md`). **Production impact: BLOCKING for production payment activation** — unchanged and not waived. |
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

**PHASE5-02 — global rate limiting — RESOLVED.** Full design in
`V3_SECURITY_MODEL.md` §13; audit narrative in `V3_RELEASE_AUDIT.md` §17.

The original finding was correct but understated it. `ThrottlerGuard` was
indeed never registered — but three auth routes (`request-otp`,
`verify-otp`, `refresh`) already carried `@Throttle` decorators, which
without a registered guard were **inert metadata**. That is worse than no
protection: `auth.controller.ts` read as though its routes were limited,
so an auditor reading that file alone would have concluded the
unauthenticated auth surface was protected. It was not, for four phases.

A second defect would have broken a naive fix: `ThrottlerModule.forRoot()`
is not `@Global` in v6 and lived in `IdentityModule`, so a root-level
`APP_GUARD` could not have resolved its storage — the identical DI trap
Phase 4 hit with `PRICING_RULES`. Both had to be fixed together.

Resolved with: a custom guard keyed on the verified-JWT user id (falling
back to IP, with `trust proxy` deliberately off so `X-Forwarded-For` is
unspoofable), registered after `JwtAuthGuard` so `req.user` exists; five
environment-tunable named policies whose `read` limit is derived from a
real workload fact (the search page's 250ms autocomplete debounce ⇒ ~240
req/min legitimate) rather than invented; `/health` as the sole exemption,
justified as infrastructure-critical rather than merely frequent; and V3's
existing `RATE_LIMITED` Persian 429 contract, carrying no budget or policy
details an attacker could use.

The deferral reasoning recorded earlier is superseded, though the concern
was legitimate. It is resolved rather than avoided: the guard stays fully
active in every suite with only limits raised, and `throttling.pg-spec.ts`
boots its own app at tiny limits to prove enforcement. A
`DISABLE_THROTTLING` switch was explicitly rejected — an off switch is
exactly why this survived four phases unnoticed. The new suite also asserts
the registration **structurally**, so deleting the `APP_GUARD` line fails
the suite even though every behavioural test would still pass at high test
limits.

*Two real bugs found in the process, both caught by CI rather than review,
and both only findable once the guard was actually active:*

1. **Registering one throttler per policy silently ANDs every limit
   together.** `ThrottlerGuard.canActivate` loops over all configured
   throttlers and requires each to pass, so five named policies applied all
   five to every route and the effective limit became their MINIMUM --
   search, documented as 300/min, would have been capped at `refresh`'s
   20/min, as would everything else. Corrected to ONE registered throttler
   with per-route `@Throttle(policy(...))` overrides, whose limits are
   functions resolved per request so they stay environment-tunable.
2. **`@SkipThrottle()` skips only the throttler literally named `default`.**
   Under the intermediate five-throttler design that left `/health` subject
   to the other four -- the exemption causing the very outage it exists to
   prevent. Moot under the single-throttler design, but recorded as a trap
   for anyone who later adds a second named throttler.

*Known limitations, disclosed:* storage is in-memory per process, so at
multi-instance scale the effective limit multiplies by instance count (a
shared Redis store is the correct fix, deliberately not adopted at current
single-instance scale). Live browser QA of throttling was not performed —
the API cannot boot locally without a financial DB connection and the local
credentials are stale — so CI, which boots the real `AppModule` against real
PostgreSQL and drives real HTTP, is the evidence.

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

---

# Final release gate (2026-08-23) — v3.0.0 released under EXC-001

**Release decision: V3.0.0 RELEASED — SANDBOX PAYMENT RELEASE EXCEPTION ACTIVE.**

The blocker recorded by the Phase 5 audit was never a code defect; it was an
unmet *policy* criterion that no engineering phase was permitted to waive on its
own. `V3_PHASE5_IMPLEMENTATION.md` §9 said so explicitly — *"a release-policy
decision for a human to make explicitly, not one this phase may take silently."*
That decision has now been taken explicitly and recorded as **EXC-001** in
`V3_RELEASE_POLICY_EXCEPTIONS.md`. Nothing was silently closed to reach it.

**GAP-06 is now formally three rows** (see the REQUIRED table above): the
original GAP-06 retained for history and marked superseded, `GAP-06a` RESOLVED /
VERIFIED, `GAP-06b` OPEN / EXTERNAL_CONFIGURATION.

**`GAP-06b` remains OPEN and was NOT closed by this release.** The exception
waives it as a blocker for the `v3.0.0` **tag**, and for that tag only. It does
not waive it for **production payment enablement**, which stays fully blocked.
The two statements are different and the distinction is the substance of the
exception — see `V3_RELEASE_POLICY_EXCEPTIONS.md` § "What this decision does and
does not mean".

**Production safety re-verified at the gate, not assumed.** The sandbox provider
fails closed under `NODE_ENV=production` unconditionally; the former
`PAYMENT_ALLOW_MOCK_GATEWAY` escape hatch does not exist and no equivalent
bypass was found; the gate is asserted directly against the provider's own logic
rather than through a cached config snapshot. A production deployment of
`v3.0.0` today has **zero enabled payment providers** and checkout fails closed
— which is what makes the exception acceptable rather than reckless.

**Every other release criterion passed on its own merits**, not by waiver: no
code-level blocker, no HIGH security finding, no financial-integrity finding,
CI green on the release commit (19 suites / 375 real-PostgreSQL tests, 0
skipped, with a CI step that makes a silent skip fatal), typecheck / lint /
build clean, all nine historical V1/V2 tags byte-identical to their remote
counterparts.

**Items carried forward unchanged, explicitly not closed by this release:**

- **`GAP-06b`** — OPEN / EXTERNAL_CONFIGURATION. Production-blocking.
- **`HOSTING_GRANTS`** — EXTERNAL_CONFIGURATION. The append-only ledger role
  contract is proven only against CI's ephemeral PostgreSQL 16 container, never
  a real target hosting provider. Docker Desktop still does not start in this
  environment and the local native PostgreSQL credentials in `.env` remain stale
  (`password authentication failed`, re-confirmed this session), so CI remains
  the only real-PostgreSQL evidence available. Production deployment
  prerequisite, not a release blocker.
- **`GAP-10`** — provisional numeric policy. **Business decision**, unchanged and
  deliberately not taken by this release gate. Made visible rather than settled:
  `GET /v1/admin/loyalty/policy` reports which values are still V2 placeholders.
- **Business service catalogue** — a business still cannot own a service
  catalogue independent of a staff professional's. **Business decision /
  deferred scope**, ADR-023's disclosed consequence of not touching booking's
  core identity concept. Not a defect.
- **`GAP-11`** (AI/SMS never exercised live) — EXTERNAL_CONFIGURATION,
  non-blocking; channels report `providerVerified: false` so a logging provider
  can never be mistaken for a delivering one.
- **`GAP-04`, `GAP-09`, `GAP-12`, `GAP-16`, `GAP-18`, `GAP-19`–`GAP-28`** —
  deferred domains not yet built in V3, each individually justified above.
  Out of scope, not overlooked.
- **RBAC remains code-based** and **audit logging remains structured-logger-based**
  rather than DB-persisted — deliberate, documented, unchanged since Phase 1.
- **Throttling storage is in-memory per process**, so at multi-instance scale the
  effective limit multiplies by instance count. Disclosed limitation; a shared
  Redis store is the correct fix at that scale.
- **`PHASE5-02`** — RESOLVED (global rate limiting enforced). Re-confirmed at this
  gate, not re-litigated.

**Live browser QA limitation, restated rather than papered over.** Authenticated
and payment-flow browser QA was **not** performed at this gate. The API cannot
boot locally — it refuses without a working `FINANCIAL_DATABASE_URL` (correct
fail-closed behaviour per ADR-017) and the local credentials are stale. The
unauthenticated frontend *was* driven in a real browser this session (homepage
renders, RTL `dir="rtl"`/`lang="fa"` correct, Persian copy correct, login CTA
present and sized); the only console errors were `ERR_CONNECTION_REFUSED` from
the absent API, exactly as expected. Authenticated and payment flows are covered
instead by the real-PostgreSQL CI suites, which boot the real `AppModule` and
drive real HTTP through supertest — the same stack a browser would hit, minus
the browser. This is stated as a limitation, not presented as equivalent.


---

# Global QA + UI/UX audit addendum (2026-08-24) — post-v3.0.0 stabilization

Full findings in `V3_GLOBAL_QA_REPORT.md` and `V3_GLOBAL_UIUX_AUDIT.md`. This
addendum records only what changes *this register*.

**`v3.0.0` was not touched.** All seven fix commits are after the tag, unpushed
pending review. No historical tag was modified.

## One correction to this register's own Phase 5 note

The Phase 5 addendum records that no local real-PostgreSQL alternative to CI was
available. That is **partly stale**: PostgreSQL 16.15 *is* installed and listening on
5432 in this environment. The operative half remains true, and is why the conclusion
is unchanged — the `beauclick_app`/`beauclick_financial_writer` credentials in
`apps/api/.env` are stale, and `pg_hba.conf` requires `scram-sha-256` on every local
connection. Recovery needs the `postgres` superuser password (absent from the repo) or
an administrative single-user reset; both credential-guessing and rewriting
`pg_hba.conf` were declined as out of bounds. Docker's daemon still does not run.
**Net evidence position: unchanged. CI remains the only real-PostgreSQL evidence.**

## New findings

**`QA-01` / `QA-02` — HIGH, the authentication entry point rejected its own audience.
CLOSED.** `canonicalizePhone()` was written to accept Persian (۰–۹) and Arabic-Indic
(٠–٩) digits and documents that as its purpose; the `@Matches` validator standing in
front of it did not, because `\d` in a JavaScript regex is ASCII-only. The
canonicalizer's Persian support was therefore **unreachable over HTTP for the whole of
V3**, in a product that is Persian-only by design and has no language switcher. The
OTP `code` had the same root cause and a worse failure mode: it is HMAC'd verbatim, so
a correct code retyped in Persian digits was scored wrong **and decremented
`attemptsRemaining`**, killing the code after five tries behind a deliberately generic
error. Fixed by folding both ranges before validation with `normalizeDigits` — the
utility **search's own DTO already used**, for the same stated reason ("one
implementation of the mapping ... so the two cannot disagree"). Auth had simply never
adopted it. This is a new instance of the recurring class this register already
tracks: a guarantee that reads as satisfied in one file while an adjacent layer
silently negates it (cf. `PHASE5-02`'s inert `@Throttle` metadata).

**`QA-10` — HIGH, the payment amount check was unit-blind. CLOSED, and it sharpens
`GAP-06b`.** `applyVerification` compared `paidAmountToman` against
`intent.amountToman` as bare numbers; `VerifyPaymentResult` carried no currency at
all, so the only thing asserting the unit was a field **name**. Iranian gateway APIs
commonly denominate in **rials** (1 toman = 10 rials), so a real adapter passing the
gateway's own figure straight through would settle a 200,000-toman order for 20,000
tomans of real money — and every existing amount-tampering test would still have
passed. The sandbox is structurally incapable of catching this, which is precisely the
limitation this register already records against `GAP-06b` ("leaves the money-unit and
field semantics of any actual gateway entirely unexercised"). `paidCurrency` is now
rule 3 of the provider contract, required and matched, failing **closed** when absent.
Three new `payment-security.pg-spec.ts` cases cover it; they require CI's PostgreSQL
and have **never executed**.

**`QA-14` — HIGH, open redirect on `/sandbox-gateway`. CLOSED.** The page took its
return address from a query parameter and navigated to it unchecked, so
`?callback=https://evil.example` rendered a plausible BeauClick payment screen and
then left the visitor on an attacker's site. **The sandbox production gate does not
cover this**: that gate disables the payment *provider*, while this is a static
frontend route that renders regardless of what the API decides. Now validated against
the configured API's exact origin, with its own spec covering the lookalike-host and
protocol-relative cases a naive prefix check would wave through.

**`QA-06` — HIGH, a failed load could destroy real data. CLOSED.** Five surfaces
treated "the request failed" and "the server says you have nothing" as the same state,
because both leave an empty array or a null. Two were more than cosmetic: **journey**
rendered its profile editor with empty initial values over data that still existed, so
submitting sent `notes: null, budgetMaxToman: null` and destroyed the profile; and
**business** rendered the *create-a-business* form to someone who may already own one.
Also fixed: no retry affordance existed anywhere in the product.

**`QA-12` — HIGH, the result page contradicted the customer's bank statement.
CLOSED.** No `duplicate_refunded` entry existed in `OUTCOME_COPY`, so a customer whose
second real charge had been automatically refunded was told "مبلغی از حساب شما کسر نشده است".

**`QA-18` — MEDIUM, rating signals have no writer. OPEN / PRODUCT GAP.**
`provider_search_signals.ratingSum` and `.reviewCount` are written by **nothing** in
the codebase — confirmed against every insert, update, and migration. The review domain
does not exist in V3 (`booking.service.ts:383` still describes reviews as something
"later phases ... will consume"), so both are permanently 0. Consequently `ratingAvg`
is always 0, the `high_rating` badge can never be awarded, and the ranking formula's
rating term always collapses to its cold-start baseline. The frontend does not
currently expose `minRating` or the `rating` sort, which limits blast radius. New here:
the *consequence* was never recorded, though the missing review domain was implicit.

**`QA-17` — MEDIUM, the Persian typeface is named but never shipped. OPEN.**
`--bc-font-family` leads with `Vazirmatn`; there is no `@font-face`, no `next/font`, no
font file, and no `public/` directory anywhere in the repo. Every user without it
locally installed silently gets a Latin-first system fallback — in a Persian-only
product, on every screen. Not fixed here: self-hosting versus a CDN has real
availability implications for an Iranian audience, and is a deployment decision rather
than a mechanical fix.

**`QA-23` — MEDIUM, no footer exists. OPEN.** `AppShell` is header + main only; there
is no `contentinfo` landmark, and therefore no route to terms, privacy, contact, or
support from anywhere in a product that takes payments and holds personal data.

Lower-severity items (`QA-03`/`04`/`05`/`07`/`08`/`09`/`11`/`13`/`15`/`16`/`24` closed;
`QA-19`/`20`/`21`/`22`/`25`/`26` open) are itemised in `V3_GLOBAL_QA_REPORT.md` §4
rather than duplicated here.

## Scope reality, recorded so it is not mistaken for coverage

The audit brief enumerates a far larger product than V3 implements. Verified absent by
exhaustive search rather than assumed: **AI**, **reviews**, **referrals**, **wishlist**,
**CRM**, **portfolio**, **B2B quotes**, **privacy export/deletion/anonymization**, **any
admin UI**, and every **professional-specific** and most **business-specific** frontend
surface. Most are already tracked (`GAP-12`, `GAP-13`, `GAP-22`, `GAP-23`, `GAP-28`);
they are restated in the QA report because a report that silently omitted them would
read as coverage.

## Carried forward unchanged

`GAP-06b` (OPEN / EXTERNAL_CONFIGURATION, production-blocking), `HOSTING_GRANTS`,
`GAP-10`, `GAP-11`, `GAP-04`, `GAP-09`, `GAP-12`, `GAP-16`, `GAP-18`, `GAP-19`–`GAP-28`,
code-based RBAC, logger-based audit logging, and in-memory throttler storage — all
re-confirmed, none re-litigated, none closed by this pass. `EXC-001` remains active and
correctly scoped; the sandbox provider's production gate was re-read and still fails
closed with no override.

## Verification status of this pass

`typecheck`, `lint`, and `build` clean; **343/343 local tests pass** (21 new). **CI has
not run these commits** — they are unpushed pending review — and the three new
`payment-security.pg-spec.ts` cases have therefore never executed anywhere. That is the
largest outstanding gap in this pass's evidence, and should be closed before any
`v3.0.1` is cut.

---

# V3.1 planning addendum (2026-08-24) — post-v3.0.1 gap reconciliation

**This addendum records only what changes *this register*.** The full reconciliation,
prioritization, dependency graph, and roadmap live in `docs/roadmap/v3.1/`:
`V3.1_GAP_RECONCILIATION.md`, `V3.1_PRODUCT_ROADMAP.md`, `V3.1_UIUX_BACKLOG.md`,
`V3.1_RELEASE_STRATEGY.md`.

**Nothing was implemented.** No code, no migration, no feature, no tag. `v3.0.1`
(`68d3d5e`) and `v3.0.0` (`cfecfdf`) are untouched; all nine historical V1/V2 tags are
untouched. This was a discovery / reconciliation / prioritization pass only.

**Method note.** Every RESOLVED, OPEN, and DEFERRED disposition in this register was
re-checked against source at `68d3d5e` rather than carried forward on its own claim — the
same discipline the 2026-08-19 addendum used. That produced seven findings and two
re-classifications no prior document records.

## Seven new findings

**`R31-01` — Privileged roles are ungrantable; the entire admin API is unreachable. OPEN /
HIGH.** `AccountResolverService.resolveOrCreate()` creates every user with
`roles: ['customer']`, and a repo-wide grep finds **no code path that ever writes
`identity.users.roles` again** — `MeController.updateMe` touches `displayName` only, no
migration or seed sets it, and `database/seeds/` contains reference data only. Every
`/v1/admin/*` route is `@RequireCapability('bc_manage_platform')`, granted only to
`platform_operator` and `administrator`. Consequently five admin controller groups are
unreachable in any real deployment: platform analytics, cross-party financial totals,
**settlement creation and reversal**, loyalty policy inspection (the endpoint `GAP-10`
relies on for visibility), notification delivery status, and **search reindex /
rebuild-projection — the only recovery path for a corrupted index**.
`bc_moderate_verification` and `bc_moderate_reviews` are unreachable for the same reason.
This register has recorded "RBAC remains code-based" since Phase 1 as a deliberate
simplification; what was never recorded is that the simplification leaves the platform
unadministrable.

**`R31-02` — The verification workflow has no caller; the `verified` signal is inert.
OPEN / MEDIUM-HIGH.** `ProviderService.transitionVerification()` is a complete,
CAS-hardened, event-emitting state machine whose **only callers in the workspace are four
lines in `apps/api/test/search-projection.pg-spec.ts`**. `ProviderController` exposes six
routes and none is a verification route; no `verification_requests`/`_evidence`/`_history`
table exists, though `V3_DOMAIN_BOUNDARIES.md` §provider names all three. Every
professional is therefore `unverified` permanently: `verifiedOnly` matches nothing,
`RankingConfig.WEIGHT_VERIFIED * verified` is always 0, and the `verified` badge can never
be awarded. **This is structurally identical to `QA-18`** (rating signals with no writer)
and was never recorded — the global QA pass found the rating half and not this one.

**`R31-03` — No file-upload or object-storage capability exists anywhere. OPEN / HIGH as a
prerequisite.** A repo-wide search of `v3/` for `S3`, `multer`, `presign`, and `upload`
returns zero matches outside `node_modules`; there is no `public/` directory.
`V3_IMPLEMENTATION_ROADMAP.md` Phase 1 lists *"Object storage wired for portfolio media +
verification evidence"* as a deliverable; it was never built and **no phase report records
dropping it**. This is the hard prerequisite behind the UI/UX audit's "zero images in the
entire product" finding and behind `GAP-23` (Portfolio) — recorded here as a missing
capability rather than a missing feature, because that is what blocks both.

**`R31-04` — `EXC-001` does not cover `v3.0.1` and does not extend to `v3.1.x`. OPEN /
BUSINESS DECISION.** `V3_RELEASE_POLICY_EXCEPTIONS.md` scopes EXC-001 to "the `v3.0.0`
release only" and its Review condition fires on *"any subsequent release (`v3.0.x`,
`v3.1.0`, …) … while GAP-06b is still open"*. The `v3.0.1` tag message records
`EXC-001 = STILL ACTIVE, unchanged and unextended` — accurate about EXC-001, and, read
against the scope clause, it means `v3.0.1` shipped **without a covering release
exception**. No harm followed: `v3.0.1` changed no payment behaviour and the production
gate still fails closed with no override, re-verified this pass. But the document that
exists to prevent silent policy drift has drifted, and the condition fires again at
`v3.1.0`. Resolution options in `V3.1_RELEASE_STRATEGY.md` §5. **Must be settled before any
V3.1 tag; letting it lapse is the specific failure mode the exception forbids.**

**`R31-05` — `identity` has four of the eight tables its own boundary document specifies.
INFORMATIONAL.** Present: `users`, `otp_requests`, `refresh_tokens`, `phone_conflicts`.
Absent: `roles`, `capabilities`, `sessions`, `business_account_approvals`. The first two
are where `R31-01`'s fix lands. `sessions`' absence is why `QA-20` cannot be fixed without
a JWT claim. `business_account_approvals` is genuinely unnecessary under ADR-023, which
resolves business ownership by row rather than by an approval workflow — recorded so the
divergence reads as deliberate rather than forgotten.

**`R31-06` — Four fully-specified domains have no schema or module. INFORMATIONAL.**
`referral`, `ai`, `admin` (`admin_audit_log`), and `privacy` (`data_requests`) each have a
complete responsibility / schema / API / event / data-ownership specification in
`V3_DOMAIN_BOUNDARIES.md` and zero implementation. Not a defect — none was in any delivered
phase's scope — but four of fourteen designed domains are absent, and the design work for
each is already done and does not need repeating.

**`R31-07` — No campaign/promotion domain exists in V3 at all. OPEN / BUSINESS DECISION,
and it supersedes two rows.** `commerce` has `orders`, `order_items`, `order_adjustments`,
`outbox_events`. There is no `campaigns`, `campaign_usages`, or `b2b_price_tiers` table,
and exactly one pricing rule is registered anywhere (`MembershipDiscountRule`). Every other
"Campaign" mention in `v3/` is a comment describing the design.

## Two re-classifications

**`GAP-04` (campaign usage-cap TOCTOU) and `GAP-19` (B2B campaign eligibility) — SUPERSEDED
by `R31-07`.** Both have been carried forward as OPEN through every phase addendum and
through `V3_0_1_RELEASE_RECONCILIATION.md` §5. Both describe V2 `CampaignService`
behaviour. **Neither can be true of V3, which has no campaign code to race.** Continuing to
list them as open V3 gaps overstates V3's risk surface and understates its scope gap. The
real question is a business one that no document records: does V3 want promotional pricing
and B2B at all? Tracked as `R31-07`. `GAP-04`'s original V2 fix is unaffected and remains
historically accurate.

## One correction to a prior addendum's framing

The Phase 3 addendum records *"No review domain exists in V3"* as a new finding, and the
global QA pass added `QA-18` for the rating-signal consequence. Both are correct. What
neither recorded is that **`verified` is dead for exactly the same reason** (`R31-02`) — so
the ranking formula has two of five terms permanently at zero, not one. The formula's
Bayesian shrinkage and cold-start blending handle it correctly and nothing is faked; the
point is that the search quality ceiling is set by absent producers, not by the engine.

## Carried forward unchanged, re-confirmed not re-litigated

`GAP-06b` (OPEN / EXTERNAL_CONFIGURATION, production-blocking — re-verified:
`PAYMENT_DEFAULT_PROVIDER=sandbox`, `PAYMENT_ENVIRONMENT=sandbox`, no adapter file, no
credential in `.env` or `.env.example`, two-condition no-override production gate intact),
`HOSTING_GRANTS`, `PHASE4-03`, `GAP-10`, `GAP-11`, `GAP-09`, `GAP-12`, `GAP-13`, `GAP-16`,
`GAP-18`, `GAP-20`–`GAP-28`, code-based RBAC, logger-based audit logging, and in-memory
throttler storage. `EXC-001` remains ACTIVE and correctly scoped — see `R31-04` for the
question that raises. All seventeen `v3.0.1` fixes (`QA-01`–`QA-16`, `QA-24`) confirmed
present as ancestors of the `v3.0.1` tag. The nine open QA findings (`QA-17`–`QA-23`,
`QA-25`, `QA-26`) are re-confirmed open and each is assigned a V3.1 phase in
`V3.1_GAP_RECONCILIATION.md` §4.

**The hosting/region decision (`V3_INFRASTRUCTURE_PLAN.md` §1) is re-flagged, not merely
carried forward.** It was declared a Phase 0 exit blocker. Phase 0 exited, five phases
shipped, and two releases were cut without it. Four V3.1 items are downstream of it —
object-storage provider, gateway callback reachability, AI reachability, and multi-instance
throttling. It is the single highest-leverage unresolved decision in the project.

## Verification status of this pass

Read-only. No build, test, lint, or CI run was performed and none is claimed — nothing was
changed that could affect them. Every finding above is grounded in direct inspection of
source, migrations, tests, `.env.example`, the CI workflow, and the `v3.0.0`/`v3.0.1` tag
objects at `68d3d5e`. Git state at the end of this pass is identical to the start except
for the four new documents under `docs/roadmap/v3.1/` and this addendum.

---

# V3.1 governance addendum — `R31-04` RESOLVED by `EXC-002` (2026-08-28)

Recorded at the `v3.1.0` release gate. This addendum changes **one** gap status —
`R31-04` — and deliberately changes no other. Nothing here closes `GAP-06b`.

## `R31-04` — RESOLVED

**`R31-04` — "`EXC-001` does not cover `v3.0.1` and does not extend to `v3.1.x`" —
RESOLVED by `EXC-002`.**

The project owner selected **Option A** of `V3.1_RELEASE_STRATEGY.md` §5 by explicit written
direction dated 2026-08-28: record a new exception rather than amend `EXC-001`.

`EXC-002` (`V3_RELEASE_POLICY_EXCEPTIONS.md`) is scoped to *"every release in the `v3.0.x`
and `v3.1.x` lines while GAP-06b remains open"*, retrospectively covering `v3.0.1` and
covering `v3.1.0`. It carries its own decision date, unmet criterion, re-verified
acceptability reasons, accepted risks, ten named safeguards, production-activation
requirements, review conditions, owner, and a dated retirement condition.

**`EXC-001` is unchanged and unamended** — byte-identical to its `v3.0.0`-era text, verified
at the release gate. It remains ACTIVE and correctly scoped to the `v3.0.0` release only.
The `v3.0.0` and `v3.0.1` release documents and tag objects were **not** rewritten; `EXC-002`
states its retrospective coverage of `v3.0.1` in its own text rather than by editing history
to imply it existed at that time.

**What this does not do:** it does not close `GAP-06b`, does not narrow or downgrade it, and
does not assert that a real payment gateway exists.

## `GAP-06b` — OPEN / EXTERNAL_CONFIGURATION (unchanged, independently re-verified)

**`GAP-06b` — real production payment gateway — remains OPEN / EXTERNAL_CONFIGURATION,
production-blocking.** Re-verified from source at the `v3.1.0` gate, not carried forward on
trust:

- `PAYMENT_DEFAULT_PROVIDER=sandbox`, `PAYMENT_ENVIRONMENT=sandbox`.
- `SandboxPaymentProvider` is the only registered provider — `payment.module.ts` provides
  exactly `[sandbox]`. No real gateway adapter file exists; `mock-gateway.provider.ts` is
  gone from source entirely.
- No merchant credential of any kind in `.env`, `.env.example`, or anywhere in tracked
  source. None were fabricated.
- `isEnabled()` returns `false` under `NODE_ENV=production` **unconditionally and first**,
  AND-ed with `PAYMENT_ENVIRONMENT === 'sandbox'`. Neither condition alone enables it.
- **`PAYMENT_ALLOW_MOCK_GATEWAY` does not exist in tracked source.** It survives only in
  comments recording its removal and in the regression test asserting its absence. No
  equivalent override was reintroduced.
- Production therefore resolves **zero** enabled payment providers and checkout fails
  closed. That refusal is the intended behaviour.

**Revenue impact: absolute — no real money can move. Production payment activation stays
blocked.** `EXC-002` waives the release criterion for a *tag*, never for enablement.

## Status after this addendum

| Item | Status |
|---|---|
| `R31-04` | **RESOLVED** by `EXC-002` |
| `GAP-06b` | **OPEN / EXTERNAL_CONFIGURATION** — production-blocking, unchanged |
| `EXC-001` | ACTIVE, historical, unchanged, scoped to `v3.0.0` only |
| `EXC-002` | ACTIVE — `v3.0.x` and `v3.1.x` lines while `GAP-06b` is open; retires at `v3.2.0` or earlier |
| `GAP-06a` | RESOLVED / VERIFIED (unchanged) |

Every other gap, exception, and finding in this register is unchanged by this addendum and
was neither re-litigated nor re-classified at this gate.

## One new finding recorded at this gate

**`R31-19` — `GET /v1/providers/{non-uuid}` returns 500 rather than 400/404. NEW / LOW /
PRE-EXISTING.** The public provider-detail route takes its `:id` path parameter without a
UUID-parsing pipe, so a malformed identifier surfaces as `INTERNAL_ERROR` instead of a
client error. The response body is the generic Persian server error with no stack or detail,
so **nothing leaks** and there is no security or data-integrity impact — but a 500 on
malformed client input is wrong and will pollute error monitoring. Present unchanged since
the original V3 provider foundation (`2599af3`) and therefore in `v3.0.0` and `v3.0.1`:
**not a V3.1 regression, and not release-blocking.** The fix is the same `ParseUuidPipe`
V3.1 already added for the admin routes. Phase: whichever phase next touches
`provider.controller.ts`.

**`R31-20` — the sandbox gateway never returned the browser to the callback. NEW / HIGH /
RELEASE-BLOCKING / PRE-EXISTING — FIXED at this gate.** Found by the `v3.1.0` release
audit's own browser re-verification, after `R31-17` had already been fixed and signed off.

`POST /v1/sandbox-gateway/:reference/decide` is an ordinary JSON route, so its answer
arrives inside the standard `{ data, meta, error }` envelope — the two callback routes
beside it carry `@SkipResponseEnvelope()` precisely because they are redirects and this one
is not. `apps/web/app/sandbox-gateway/page.tsx` read `body.accepted` off the **envelope**,
where it is permanently `undefined`, so the "was this decision refused?" guard fired on
**every** response including a successful one. The gateway recorded `outcome = paid`, and
the customer was then shown the false error «این تراکنش پیش‌تر نهایی شده است» and **never
returned to the callback** — so verification never ran, the order stayed `pending`, and the
slot stayed on hold until expiry.

The same browser-only shape as `R31-17`, a different root cause, and invisible to every
automated suite for the same reason: the API specs call `handleCallback` directly and never
drive the gateway page, and `sandbox-callback.spec.ts` asserted the return-URL **allowlist**
— "is this address safe to navigate to", never "do we navigate".

Why it survived the earlier browser QA: both the previous QA pass and this audit's first
browser run completed the return leg **by navigating to the callback URL by hand**, and read
the resulting `paid` order as success. The manual step masked the missing automatic one.
This gate's re-run was performed hands-off — one click, no manual navigation — which is what
exposed it.

**Fix:** read `envelope.data` rather than the envelope. **Regression:**
`apps/web/test/sandbox-gateway-page.spec.tsx` (5 cases) asserts the success path navigates
to the callback carrying only the reference — and that the outcome is *not* carried — and
that each genuine refusal (already-settled, sandbox-disabled, gateway error) still refuses
without navigating. The suite was verified to FAIL (3 of 5) with the fix reverted.
**Verified end to end in a real browser against the rebuilt production bundle: one click on
«پرداخت موفق» → self-redirect to `/callback/sandbox` → order `paid`, booking `confirmed`,
ledger commission 45,000 + receivable 255,000 exactly once.** This is the first time the
browser payment loop has completed with no manual step.
