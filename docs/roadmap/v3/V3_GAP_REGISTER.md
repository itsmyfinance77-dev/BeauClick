# V3 Gap Register

Status: Phase 2 output. Every item below was independently confirmed against V2.3.0 source/tests by the domain-discovery pass — this is not a re-statement of `docs/roadmap/PRODUCT_GAP_REGISTER.md`, though it draws on it and corrects it in one place (see AUTH note below on that document's own staleness).

Classification: **REQUIRED** (must be resolved before V3 can be considered done for that domain), **RECOMMENDED** (should be fixed, real but not launch-blocking), **OPTIONAL** (nice-to-have, evidence-gated), **DEFERRED** (explicitly out of scope, tracked so it isn't silently lost).

---

## REQUIRED

| ID | Gap | Domain | Evidence |
|---|---|---|---|
| GAP-01 | Ledger append-only guarantee is application-convention only — no DB trigger, revoked grant, or constraint prevents an `UPDATE`/`DELETE` on `wp_bc_ledger_entries`. | Financial | Confirmed by full-codebase grep: no mutating method exists in `LedgerService`, but nothing at the schema layer enforces it either. V3's financial-service must add real DB-level enforcement. |
| GAP-02 | Audit-logging bypass is a recurring bug class, not a one-off — a REST-reachable, capability-gated admin mutation skipping the audit call its wp-admin twin makes has been found and fixed **three separate times** across two plugins (B2B account approve/reject, B2B quote pricing, Loyalty tier/plan/benefit CRUD). One instance is **still open**: `B2BController::set_tiers` has zero audit logging as of `v2.3.0`. | Admin / cross-cutting | `PRODUCT_GAP_REGISTER.md` lines ~677, 764, 786, 793 (`ADMIN-05/06/07`); confirmed directly in `B2BController.php` — no `audit_log()->record()` call in `set_tiers()`. |
| GAP-03 | Booking→Order creation has no idempotency guard — a re-fired `beauclick/booking/after_create` filter always creates a second, distinct WooCommerce order for the same booking. Currently self-heals only by accident (the second order's `payment_complete()` lands in the "paid but unconfirmable" path and auto-refunds). | Commerce/Payment | `VERSION_2_ARCHITECTURE_PLAN.md:2695`; confirmed in `BookingOrderBridge::create_order_for_booking()` — no dedupe check before `wc_create_order()`. |
| GAP-04 | Campaign usage-cap enforcement (`usage_limit_total`/`usage_limit_per_customer`) has a confirmed, open TOCTOU race — the eligibility check and the usage-record insert are not atomic across different bookings under real concurrent load. | Campaign | `PRODUCT_GAP_REGISTER.md:792` (`CAMP-03`), open/unfixed. |
| GAP-05 | Financial cross-professional isolation is enforced only at the REST controller boundary (`MyFinanceController`), not at `LedgerService`'s own data-access layer — a future caller that reaches `LedgerService` without going through the gated controller would not be isolated by the service itself. | Financial | Confirmed by reading every public method on `LedgerService` — no row-level access control exists independent of caller discipline. |
| GAP-06 | No real payment gateway is configured or integrated in any environment — `ZARINPAL_MERCHANT_ID` is always empty; only a dev-only, environment-gated Cash-on-Delivery stand-in has ever been exercised. | Payment | `.env.example:29`; `PRODUCT_GAP_REGISTER.md:308,443`. Explicit precondition for a real V3 launch, not merely a code gap. |
| GAP-07 | No formal event contract exists anywhere. `beauclick/*` action hooks are plain, unversioned WordPress `do_action()` calls with zero production subscribers in at least one case (`otp_generated`); the separate `wp_bc_events` analytics table has a free-text `event_type` string and an unvalidated `meta` JSON blob, documented only in a code comment — no schema, no versioning, no producer/consumer registry. | Cross-cutting (Phase 11) | Confirmed by direct inspection of `EventLogger.php` and every `do_action('beauclick/...')` call site across all 10 plugins researched. See `V3_EVENT_CATALOG.md`. |
| GAP-08 | The shared ownership-check helper (`RestController::require_owner_or_capability()`) is dead code — defined but never called anywhere in the codebase, because most real ownership relationships are indirect (booking→provider→user, not booking→user directly) and the helper doesn't support that indirection. Every domain reimplements its own inline gate instead. | Authorization / cross-cutting | Confirmed by grep across every plugin extending `RestController` — zero call sites. |
| GAP-09 | SEO was not covered by this Phase 2 discovery pass at all — no agent was scoped to investigate meta tags, structured data/JSON-LD, sitemaps, canonical URLs, or Persian-slug SEO behavior. | SEO | Self-identified gap in this discovery process, not a finding about the code. Required before `V3_ARCHITECTURE_PLAN.md`'s service boundaries can be considered final for provider-service/frontend. |
| GAP-10 | Every business-tunable numeric policy across the platform is explicitly provisional, not a settled business decision: OTP timings (120s expiry, 5 max attempts, 60s cooldown), booking hold window (15 min) and concurrent-hold cap (5), max reschedules (2) and minimum notice (6hr), rebooking interval (30 days), retention inactivity window (60 days), commission rate (15%), loyalty point values (10/booking, 5/review, 10/shop-order), referral reward split (50/50). | Cross-cutting | Every one of these constants carries an explicit `NEEDS_BUSINESS_DECISION` marker or equivalent docblock language in its own source file. V3 must not silently re-adopt these as final requirements — they need a real business sign-off pass. |

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

## Note on trusting the existing gap register

`docs/roadmap/PRODUCT_GAP_REGISTER.md` is itself confirmed to contain at least one **stale** entry: it lists rescheduling (BOOK-03) as `MISSING` in one section while a later section of the *same document*, and the actual shipped code (`RescheduleService`, full REST routes, full test coverage), show it's been complete since V2.2 Step 15. This is not a criticism of that document — it's an accurate historical log of a point-in-time audit — but it means **the register must be read as a timeline, not a live dashboard**, and every item this V3 Gap Register cites from it was independently re-verified against current source before being carried forward here.
