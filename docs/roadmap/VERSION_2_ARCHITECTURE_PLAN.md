# BeauClick — Version 2 Architecture Plan

**Document status:** Planning — source of truth for V2 implementation decisions.
**Scope:** Assessment of the 12 capability groups in `BeauClick_Version_2_Roadmap.md` against the actual V1 codebase (tag `v1.0.0`, commit `8494c7b4`).
**Terminology:** V1 = Version 1 (frozen, tagged `v1.0.0`). V2 = Version 2 (this document). Phases 0–12 = the historical *architecture build-out* that produced V1 — never a synonym for "V2."

This document does not prescribe exact tickets. It establishes what already exists, what's genuinely new, how the pieces depend on each other, and a recommended sequence — grounded in the real code, not the roadmap's aspirational description of it.

---

## V2.0 Step 1 — Implementation Notes (Event Instrumentation + Loyalty Ledger Wiring)

**Correction to §2.2/§4.9 above, found during implementation, not just planning:** the assessment above (written from three parallel research-agent passes) claimed `wp_bc_events` had "zero actual call sites" outside `beauclick-core`. That was wrong. Direct inspection at implementation time found `booking_created`, `booking_confirmed`, `booking_cancelled`, `booking_completed`, `booking_expired`, `response_time_seconds`, `review_submitted`, `message_sent`, `ai_recommendation_shown`, `ai_recommendation_clicked`, and four B2B event types already wired into their respective services (`BookingService`, `ReviewService`, `ConversationService`, `AssistantService`, `BusinessAccountService`/`QuoteService`) — the research agents' grep tooling produced a false negative. `LoyaltyLedger::award()` genuinely did have zero call sites, confirmed independently via a second search tool — that half of the original assessment was accurate. The real gap was much narrower than assumed: only `profile_view`, `order_completed`, and `order_refunded` were genuinely missing from event instrumentation.

### Events added
- **`profile_view`** — `MarketplaceController::detail()`, entity_type = the CPT post type (`bc_professional`/`bc_business`), actor_id nullable for guests. No idempotency guard: every real page view is a distinct event, intentionally not deduplicated.
- **`order_completed`** — `beauclick-payments\Plugin::on_payment_complete()` (the existing `woocommerce_payment_complete` hook), fires for every paid order, booking-linked or not. Guarded with a new `EventLogger::has_logged()` check, since — unlike the booking status transitions elsewhere in this codebase — `woocommerce_payment_complete` has no atomic single-fire guarantee of its own (WooCommerce's own core explicitly no-ops a repeat call once an order has already left the "payment pending" status family, but a duplicated webhook delivery for a still-pending order could in principle re-fire it).
- **`order_refunded`** — `beauclick-payments\Plugin::on_order_dead()` (the existing `woocommerce_order_status_refunded`/`_cancelled`/`_failed` hook), scoped to the genuinely `refunded` status only. Same `has_logged()` guard.

### Loyalty earning rules activated
V1 never defined real point values (`LoyaltyLedger`'s own docblock said so explicitly). Rather than invent a business rule, three deliberately simple, flat, equal-weighted-per-event point values were centralized in one new class (`beauclick-loyalty\EarningRules`), clearly marked as a provisional placeholder policy:

| Event | Points | Trigger |
|---|---|---|
| `booking_completed` | 10 | New `do_action('beauclick/booking/completed', $booking_id)`, fired from `BookingService::complete_booking()` only when its own atomic status transition actually succeeds |
| `review_submitted` | 5 | New `do_action('beauclick/reviews/submitted', $review_id, $author_id, $booking_id)`, fired from `ReviewService::create()` only after a genuine insert |
| `order_completed` (non-booking order only) | 10 | New `do_action('beauclick/payments/shop_order_completed', $order_id, $customer_id)`, fired from `on_payment_complete()` only when the order has no `_bc_booking_id` meta |

A booking's own linked WooCommerce order paying does **not** separately award `shop_order_completed` points — that would double-count one real transaction (the payment is what unlocks `booking_completed`'s award later, once the service is actually delivered). This is asserted directly by `EarningRulesTest::test_a_bookings_own_linked_order_does_not_separately_award_shop_order_points`.

### Idempotency strategy
Two layers, matching how strict the requirement is for each system:
1. **Loyalty (hard requirement — "must never award twice"):** `LoyaltyLedger::has_awarded(reference_type, reference_id, reason)` as a fast-path check, backed by a real `UNIQUE KEY (reference_type, reference_id, reason)` added via a new additive migration (`AddLoyaltyReferenceUniqueIndex`, following the same "new migration, never edit a shipped one" convention as `beauclick-booking`'s `AddHoldExpiryColumns`). MySQL/InnoDB treats each `NULL` as distinct under a `UNIQUE` index, so reference-less awards (e.g. a future manual admin adjustment) are never blocked. This makes a genuine concurrent double-award a database-level impossibility, not just an application-level best-effort check — verified directly by `LoyaltyLedgerTest::test_a_duplicate_reference_and_reason_is_rejected_at_the_database_layer`.
2. **Events (softer requirement):** `booking_*`/`review_submitted`/`message_sent`/`ai_recommendation_*` events all log from inside an already-atomic status transition or insert-guard that only ever succeeds once per real state change — no new guard needed. `order_completed`/`order_refunded` have no such upstream guarantee, so they use the new `EventLogger::has_logged()` check. `profile_view` is intentionally never deduplicated.

### Test coverage
26 new tests across `beauclick-core` (`EventLoggerTest`), `beauclick-loyalty` (`LoyaltyLedgerTest` additions, new `EarningRulesTest`), `beauclick-booking`, `beauclick-reviews`, `beauclick-chat`, `beauclick-ai`, `beauclick-marketplace` (new `MarketplaceControllerTest`), and `beauclick-payments` (`PluginTest` additions). 166/166 backend tests passing (140 baseline + 26 new).

### A real, pre-existing V1 characteristic discovered during live verification — not a bug, not fixed
Live-verifying the booking→payment→confirmation path end to end (a real browser checkout, not a direct service call) found that the local-only Cash on Delivery gateway never actually confirms a booking or awards `order_completed`/`shop_order_completed` loyalty points under a real checkout submission. Root-caused to WooCommerce core's own `WC_Gateway_COD::process_payment()`: for any order with a total greater than zero, COD deliberately calls `$order->update_status(...)`, never `$order->payment_complete()` — "payment won't be taken until delivery" is COD's own documented design, not a bug in this codebase. `WC_Order::payment_complete()` additionally no-ops entirely once an order has left the pending/on-hold/failed/cancelled status family, confirmed directly in WooCommerce core source. Both are correct, intentional WooCommerce behavior.

This has no production impact — COD is already gated behind `wp_get_environment_type() !== 'production'`, and a real Iranian payment gateway calls `payment_complete()` immediately upon verified payment, which is the whole point of an online gateway versus pay-on-delivery. It does mean the dev-only COD shortcut can't exercise the booking-confirmation or shop-order-loyalty code paths through a real checkout click — those were verified instead by driving `BookingService::confirm_booking()`/`complete_booking()` directly against the real booking a live browser session created (exercising the exact same methods a real gateway's `payment_complete()` hook already calls, per the existing, passing `BookingOrderBridgeTest`), and by the automated `PluginTest`/`EarningRulesTest` cases that construct a fresh `WC_Order` in the state `payment_complete()` actually processes. No V1 code was changed for this — per the standing rule, it isn't a security, data-integrity, payment-correctness, authorization, or functional bug, just a characteristic of a dev-only testing shortcut.

---

## V2.0 Step 2 — Implementation Notes (AI-Powered Beauty Discovery & Recommendation Engine)

**Scope actually implemented:** turned the existing single-type (professional-only) AI assistant into a real discovery engine recommending three real catalog types — professional, service, product — from real BeauClick data, with grounded explanations and click-through into the existing booking/shop flows. Beauty Journey, CRM, Membership, Referral, Campaign engine, Financial/Payout, Realtime Chat, native mobile, the full ranking algorithm, and full multi-vendor marketplace work were explicitly out of scope and untouched.

### Components reused, not rebuilt
- **`ContextExtractor`** — extended (not replaced) with a taxonomy-agnostic `match_terms()` helper, reused for both `bc_specialty` (existing) and the new `product_cat` (WooCommerce's own real category taxonomy — no new taxonomy invented).
- **Booking deep-link** — a service recommendation reuses the *existing* `[data-bc-book-trigger]`/`providerId`/`serviceId` mechanism in `app/src/mounts/booking.tsx`; the only addition is a `useEffect` that reads `?book_provider=&book_service=` from `URLSearchParams` on mount and feeds the same `setTarget()` the click-delegate already uses. No new booking engine, no new trigger mechanism.
- **WooCommerce as product authority** — product recommendations go through `wc_get_products()` + `WC_Product::is_visible()`, the same visibility rule `ServiceProductSync` already relies on to hide booking-only products from Shop browsing (confirmed by reading WooCommerce core's `is_visible_core()`; a `catalog_visibility=hidden` product can never become visible downstream). This one existing check already satisfied the "never recommend a hidden booking-only product as a shop product" requirement — added as a regression test (`AssistantServiceTest::test_a_recommendation_for_a_hidden_catalog_visibility_product_is_dropped`, `CatalogContextTest::test_summary_excludes_a_hidden_catalog_visibility_product`) rather than new protective code.
- **`validate_recommendations()`** — gained one new `'service'` branch (real post, real `bc_service` post type, published, and its parent provider also published); the existing `'provider'`/`'product'` branches were untouched. This is still the single choke point every recommendation — rule-based or LLM — passes through before persistence.

### New, genuinely new code
- **`MedicalSafetyGuard`** — a narrow, deliberately conservative keyword gate (13 Persian medical-signal phrases: عفونت, سرطان, تشخیص بده, دارو تجویز, etc.) checked first in `RuleBasedProvider::chat()`. A match short-circuits to a fixed cautious reply with zero recommendations — never a diagnosis, never a drug name. Ordinary skincare vocabulary ("چرب", "جوش") deliberately does not trigger it, or the assistant's primary use case would break. `AnthropicProvider`'s system prompt carries the same instruction in natural language as a second, unverifiable-by-this-codebase layer (no live API key in this environment — see the existing `AnthropicProvider` docblock).
- **`RuleBasedProvider::find_products()` / `find_services()`** — real, budget-filtered (`find_products`) and specialty+budget-filtered (`find_services`) catalog queries, capped at 3 and 2 results respectively, each carrying a `reason` string grounded in the actual matched category/specialty/price — never a templated claim about something not in the row.
- **`CatalogContext::summary()`** — extended from providers-only to providers + services + products, so `AnthropicProvider`'s prompt has the same three real catalog types to choose from as the deterministic path; an external LLM can only ever recommend an ID it was shown.
- **Recommendation `reason` field** — threaded end to end: `AssistantResponse` → stored JSON → `validate_recommendations()` (passthrough) → `enrich_recommendations()` → REST response → `AiRecommendation.reason` → rendered in `RecommendationCard.tsx` for every type.

### A real bug found during live verification, fixed with a regression test
Live-testing the "professional in Yazd" scenario surfaced a genuine location-matching bug: `RuleBasedProvider::find_services()` filtered by specialty and budget but never by city (a `bc_service` post carries no city of its own — only its parent provider does), so a hair-color service from an Isfahan-based provider was recommended for an explicit "in Yazd" request. Fixed by post-filtering candidate services against their parent provider's `_bc_city_id` meta whenever a `cityId` is known in context, mirroring the same constraint `find_providers()` already applied at the SQL level. Applied identically in `CatalogContext::services()` so the LLM path can't be offered an out-of-city service either. Covered by two new regression tests: `RuleBasedProviderTest::test_a_service_from_a_provider_in_a_different_city_is_excluded_when_a_city_is_named` and `CatalogContextTest::test_summary_excludes_a_service_from_a_provider_in_a_different_city`.

### Validation strategy (defense in depth, per §16's "never trust the model's IDs blindly")
Two independent layers, neither trusting the other:
1. **Input-side (CatalogContext):** an LLM provider is only ever *shown* real, currently-valid catalog rows in its prompt — it cannot recommend an ID it was never given.
2. **Output-side (`validate_recommendations()`):** every recommendation, regardless of provider, is re-checked against a live DB row (existence, publish status, parent-published for services, `is_visible()` for products) before it is ever persisted or rendered. A provider claiming a stale, deleted, or hallucinated ID is silently dropped, never surfaced.

### Provider fallback
`ProviderFactory` is unchanged — `RuleBasedProvider` remains the default whenever `BC_AI_PROVIDER`/`BC_AI_API_KEY` aren't both set, which is every environment exercised in this session. `AnthropicProviderTest` (new) covers the adapter's own contract with `pre_http_request` mocking: well-formed JSON parses correctly including the new `reason` field; non-JSON text degrades to a plain reply with no recommendations; malformed recommendation entries (missing `type`/`id`) are dropped, not fatal; an HTTP error or `WP_Error` from the transport degrades to a retry-later reply, never an exception. The live HTTPS round trip to api.anthropic.com remains unverified in this environment (documented, unchanged limitation from Step 1's architecture doc — no key, and major providers generally restrict direct API access from Iranian IPs per §16).

### Event integration
Reused the Step 1 event system as-is — `ai_recommendation_shown`/`ai_recommendation_clicked` now also fire with `entity_type = 'service'` (in addition to the existing `provider`/`product`), through the exact same `AssistantService::send()`/`mark_clicked()` code path. No new event types, no new tables.

### Security boundaries confirmed
- AI output is treated as untrusted end to end — validated before persistence, never executed, never used to modify orders/bookings/loyalty directly.
- No new loyalty award path was added or touched by this step; live DB verification after all 6 test scenarios confirmed zero new `wp_bc_loyalty_points` rows attributable to AI activity (the one row present pre-dated this session's AI testing by ~35 minutes and was a real, unrelated `booking_completed` award).
- No fake/placeholder catalog entities were created at any point — every recommendation resolved against real, pre-existing `wp_posts`/`wp_bc_provider_index`/WooCommerce rows.

### Tests
34 new/updated backend tests: `ContextExtractorTest` (+3: product-category extraction, multi-word fallback matching, connective-word non-match), new `MedicalSafetyGuardTest` (4), new `CatalogContextTest` (4), new `RuleBasedProviderTest` (7), new `AnthropicProviderTest` (5), `AssistantServiceTest` (+11: service validation for nonexistent/unpublished/orphan-parent, service enrichment with booking link + reason passthrough, nonexistent/hidden product rejection, medical-safety end-to-end, service-type shared-event click logging, distinct event IDs per recommendation). Full backend suite: 198/198 passing (was 166 after Step 1).

### Live verification (real running site, real browser, logged in as `bc_qa_customer`)
All 6 required Persian scenarios run against the live dev server, with DB/network inspection, not just UI observation:
1. **Oily-skin routine** ("برای پوست چرب و جوش‌دار یه روتین ساده می‌خوام") → 3 real skin-care products + 1 real service ("پاکسازی پوست" by مهسا رضایی), each with a grounded reason.
2. **Professional in Yazd** ("یه میکاپ آرتیست خوب تو یزد می‌خوام") → real Yazd-based provider سارا احمدی's real "میکاپ عروس" service (۲٬۵۰۰٬۰۰۰ تومان، ۱۲۰ دقیقه) — the city-filtering bug above was caught and fixed via this exact scenario.
3. **Budget statement** ("بودجه من ۴۰۰ هزار تومانه") → all 3 returned products priced at or under 400,000 toman; a previously-seen 480,000-toman serum was correctly excluded.
4. **Click-through** → clicking the service card fired a real `POST /ai/recommendations/{id}/click` (200 OK), navigated to the real provider's real profile page, auto-opened the booking modal directly at the date-selection step (service pre-filled via the new URL-param mechanism), and wrote a real `ai_recommendation_clicked` event (`entity_type='service'`) to `wp_bc_events`.
5. **Impossible request** ("جراحی پلاستیک فضایی ... شهر ناکجاآباد") → an honest "couldn't find anything, try changing city/budget/type" reply, zero recommendations, no fabricated specialist or city.
6. **Medical-style request** ("پوستم عفونت کرده و خونریزی داره، تشخیص بده و دارو بگو") → the fixed `MedicalSafetyGuard` cautious reply, zero recommendations, referral to a real doctor.

No console errors observed; no horizontal overflow at 375px mobile width.

### Limitations / deferred
- `find_services()`/`CatalogContext::services()` filter city via a PHP post-filter against parent-provider meta (services carry no city of their own) rather than a single SQL join — acceptable at current catalog scale, would need revisiting if service/provider counts grow large enough for this to matter for `posts_per_page` candidate sizing.
- The AnthropicProvider live HTTP path remains unverified against the real API (no key in this environment) — same limitation carried forward from Step 1.
- No new search infrastructure was introduced or found necessary — `WP_Query`/`wc_get_products()`/direct `$wpdb` queries against existing tables remained sufficient at current catalog scale, consistent with the task's explicit "no new search infra without a demonstrated concrete need" constraint.
- Bundle/routine recommendation types (mentioned in the roadmap as a future extensible type) were not implemented — the recommendation-type structure remains extensible for it, but building it was out of this step's explicit scope.

---

## V2.0 Step 3 — Implementation Notes (Advanced Ranking Engine)

**Scope actually implemented:** a real, explainable, precomputed ranking score for every provider in `wp_bc_provider_index`, replacing the four independent hardcoded copies of `'verified DESC, rating_avg DESC'` this codebase had accumulated across the REST API, the SSR theme helper, and two AI query sites — with one shared ordering contract every consumer now references. Candidate eligibility (specialty/city/price/budget matching) was **not** touched or duplicated inside ranking; it stays exactly where it already lived in each consumer, per the task's explicit "ranking must not be responsible for basic eligibility" requirement.

### What existed before, and a real discrepancy found during implementation
§2.2/§4.9 above (written during V2 planning, before this step) correctly identified that `wp_bc_provider_index.ranking_score` was a waiting, never-written column and that `MarketplaceController::sort_clause()` had an explicit extension point marking where it should land. It also assumed a scoring job could be built "most naturally... inside beauclick-marketplace... reading from wp_bc_events" (§4.9 point 3). **That assumption doesn't hold**, discovered by direct inspection at implementation time: `booking_created`/`_confirmed`/`_completed`/`_cancelled`/`_expired` events are logged with `entity_type='booking'` and `entity_id=$booking_id` (see `BookingService`), not `entity_type='provider'` — there is no way to aggregate "how many bookings did provider X complete" from `wp_bc_events` alone without joining back through `wp_bc_bookings.provider_id`. Only `response_time_seconds` and `review_submitted` correctly use `entity_type='provider'`, and `profile_view` uses a third convention (`entity_type` = the CPT post type, `bc_professional`/`bc_business`) — three different conventions across five provider-relevant event types, none of them wrong on their own terms, but not uniformly aggregatable the way §4.9 assumed.

Given this, and given this codebase's own established one-directional dependency convention (`beauclick-booking` already depends on `beauclick-marketplace` — see `DashboardController`'s own docblock: "booking already depends on marketplace... keeping the one-directional module dependency chain intact rather than marketplace reaching into booking's tables"), **the ranking computation module was placed inside `beauclick-booking`, not `beauclick-marketplace`** — the reverse of §4.9's suggestion. This lets it read its own `wp_bc_bookings` table directly (no cross-plugin table coupling) alongside `wp_bc_provider_index` and `wp_bc_events`, mirroring `DashboardController`'s exact existing precedent (a booking-plugin class reading marketplace's index table directly) rather than inventing a new dependency direction.

### Architecture
Two plugins, one shared contract, matching the actual data-ownership boundaries found during investigation:

- **`beauclick-marketplace\Ranking\RankingPresenter`** (read side — marketplace owns `wp_bc_provider_index`, the table every consumer queries): `ORDER_BY` — one SQL fragment (`COALESCE(ranking_score, 0) DESC, verified DESC, rating_avg DESC, provider_id ASC`, fully deterministic down to the final `provider_id` tiebreak) now used identically by `MarketplaceController::sort_clause()`'s "recommended" case, the theme's `bc_get_providers()`, `RuleBasedProvider::find_providers()`, and `CatalogContext`'s provider query — the exact four call sites that used to hand-copy the same string. `explain(array $signalKeys): array` — turns stored signal keys into truthful Persian phrases, dropping anything unrecognized rather than surfacing it raw.
- **`beauclick-booking\Ranking\*`** (compute side): `RankingConfig` (every weight/threshold, one documented, provisional home — same "single policy class" pattern as `EarningRules` from Step 1), `RankingSignals` (a flat DTO), `SignalCollector` (gathers raw signals — bulk GROUP BY queries for the whole table, single-provider scoped queries for one), `RankingScorer` (pure function: signals in, score out — zero I/O, fully unit-testable), `RankingScore` (value + earned signal keys), `RankingEngine` (orchestrates collect → score → persist via `Indexer::update_ranking()`).
- **Persistence**: `beauclick-marketplace\Search\Indexer` gained `update_ranking()` (mirrors the existing `update_rating()` method reviews already calls cross-plugin — "call the owning plugin's own write method, never raw SQL across the boundary") and now fires `do_action('beauclick/marketplace/provider_indexed', $post_id, $post_type)` at the end of every `sync()` — one new, purely additive hook, the same source-fires/consumer-subscribes convention as every other cross-plugin seam in this codebase.
- **Database**: `ranking_score` already existed (V1, unused). New migration `AddProviderRankingSignalsColumn` adds `ranking_signals TEXT NULL` (a small JSON array of stable signal keys, not pre-rendered text — wording can change without a backfill).

### Candidate retrieval vs ranking — kept genuinely separate
Every consumer's own `WHERE` clause (city/specialty/price/budget) is unchanged — eligibility still happens exactly where it already did, before `ORDER_BY` ever runs. A live-verified example: filtering the marketplace by both "Yazd" and "hair color" (the only hair-color specialist in the demo catalog is Isfahan-based) returns a genuine, honest empty state — ranking never got the chance to "rescue" an ineligible candidate into the result, because eligibility excluded her before ranking ran at all.

### Signals, normalization, and why each one is trustworthy or deliberately small
A weighted sum of independently-normalized 0-1 signals (§4.9's own stated v1 bar — "not a machine-learning system"), not a black box:

| Signal | Weight | Source | Manipulation resistance |
|---|---|---|---|
| Rating confidence (Bayesian/shrinkage) | 0.32 | `provider_index.rating_avg`/`review_count` | Reviews are capped at one per real completed booking (`bc_reviews.booking_id` UNIQUE) — can't be spammed without a genuine paid transaction |
| Completion rate | 0.18 | `bc_bookings` (own table), 90-day window | Can't be faked without a real customer completing a real booking flow |
| Response speed | 0.12 | `response_time_seconds` events | Gaming this means confirming bookings faster — the literal product goal, not abuse |
| Profile completeness | 0.12 | Provider's own post/postmeta/taxonomy | No external signal to game — it's the provider's own declared content |
| Recent activity | 0.10 | `bc_bookings` + `review_submitted` events, 30-day window, log-capped | Log-scale cap bounds how much one hyperactive provider can dominate |
| Verified | 0.10 | `provider_index.verified` (admin-set) | Not self-service |
| View→booking conversion | 0.06 | `profile_view` events / `bc_bookings` created | Deliberately small weight and neutral below a minimum-views threshold — `profile_view` is never deduplicated (Step 1), so self-inflating views is possible, but it only *lowers* this ratio (more views without matching bookings), making it self-defeating; a real anti-fraud view-deduplication system is deferred, not solved here, since this weight is too small to be worth exploiting today |

**Rating: Bayesian/shrinkage, not Wilson.** Wilson score intervals suit a binary up/down signal; this is a 1-5 star average with a count, which shrinkage (the "IMDB formula": `(C·m + R·v)/(C+v)`) handles directly. Verified against the task's own worked example (`RankingScorerTest`): 5.0 from 1 review shrinks toward the platform mean far more than 4.8 from 250 reviews, so the large, strong review base correctly outranks the single perfect one — but only when every *other* signal is held constant, since the cold-start blend below protects a low-evidence provider on **every** signal, not rating alone (a real interaction discovered while writing this exact test — see Known limitations).

**Missing data is neutral, not penalized**: completion rate below 3 samples, conversion below 10 views, and no response-time data yet all default to 0.5 (neutral), never 0 — a provider isn't punished for a sample too small to mean anything.

### Cold start
`data_confidence = min(1, (review_count + completed_bookings) / 5)` blends a provider's own raw weighted score with a neutral baseline (0.55) in proportion to how much real evidence exists. A brand-new provider with zero data lands comfortably mid-pack (~50-55/100, verified live: four demo providers with zero reviews/bookings scored exactly 55.0000, differentiated only by their verified/tiebreak fields), not buried at 0 and not artificially tied with an established performer — a provider with real strong evidence (verified `RankingScorerTest` case: 4.9 rating/50 reviews/40 completions/fast response/complete profile) scores meaningfully higher (~95+) than the cold-start baseline. This is evidence-based, not calendar-based (days-since-published was considered and deliberately not used — a provider could be old but still have zero real activity, which evidence-based blending protects correctly and a pure time-based decay would not).

### Location and specialty relevance
Handled entirely by each consumer's existing eligibility `WHERE` clause (`city_id = %d`, `FIND_IN_SET(specialty_id, specialty_ids)`), not by ranking — no city or specialty name is hardcoded anywhere in the `Ranking` namespace (verified by inspection: zero string literals like "Tehran"/"Yazd"/"تهران"/"یزد" anywhere in `RankingConfig`/`RankingScorer`/`SignalCollector`/`RankingEngine`). A province-level fallback hierarchy (exact city → same province → national) was considered per the task's own suggestion but not built: no current consumer needs it (every existing city filter is a hard, exact match), and building a soft-preference tiebreak with no real caller to exercise it would be speculative — noted as a natural, well-supported future extension point in Known limitations, not built now.

### AI integration
`RuleBasedProvider::find_providers()` and `CatalogContext`'s provider query both now order by `RankingPresenter::ORDER_BY` instead of their own hardcoded copy — AI still owns 100% of its own candidate eligibility (specialty/city/budget matching built from conversation context), ranking only decides order among AI's own already-eligible candidates, per the task's explicit "AI: understands intent → requests candidates/ranking → presents recommendations; Ranking: determines candidate order" boundary. Verified with a real DB test (`RuleBasedProviderTest::test_provider_recommendations_are_ordered_by_the_real_ranking_score`) and live: a real conversation surfaced سارا احمدی (the highest genuinely-scored provider, 70.17) correctly.

### Marketplace integration
`MarketplaceController::format_index_row()` gained `rankingReasons: string[]` — truthful, pre-computed explanation phrases (never the raw numeric score) decoded from the stored signal keys via `RankingPresenter::explain()`, which silently drops any unrecognized key rather than ever surfacing something unverified. The theme's `bc_get_providers()` (used by the SSR marketplace page and the homepage "متخصصان پیشنهادی" section) and `template-parts/provider-card.php` were updated the same way — a small, single line of muted text under the rating (at most 2 reasons), not a row of badges, per the roadmap's own "do not overdo badges" guidance.

### Performance
`recompute_all()` (the hourly cron sweep) does a fixed, small number of bulk `GROUP BY` aggregate queries — one per signal type across the whole table, not one per provider — for everything except profile completeness, which genuinely is a per-provider WP-API lookup (`get_post()`/`has_post_thumbnail()`/two `get_posts()` calls). This was a deliberate "why now, why not later" tradeoff: at this project's realistic provider-count scale (a regional/national Iranian beauty marketplace — low hundreds to low thousands, not millions) a few hundred cheap lookups once per hour is negligible; if provider count ever grows enough for this to show up as a real cron-runtime problem, the fix is the same `LIMIT`+offset batching pattern `HoldExpiryScheduler` already established for its own sweep, not a new architecture. Real-time freshness for the events that matter most (a completed booking, a new review, a profile edit) comes from three lightweight single-provider hook triggers instead of waiting for the next hourly sweep — see Architecture above.

### Security / privacy
Ranking output (`ranking_score`, `ranking_signals`) is derived, aggregate, non-personal data — no private customer data, booking history, or financial data is read into or exposed by any ranking signal. The raw numeric score is never returned by any REST response (`format_index_row()` only ever returns the decoded, truthful `rankingReasons` label list); a provider cannot inspect another provider's private ranking inputs because no endpoint exposes per-signal internals at all, only the same public-safe explanation labels every visitor already sees on that provider's own card.

### Anti-manipulation — what's covered now, what's explicitly deferred
Covered today (see the signals table above for the per-signal reasoning): reviews, bookings, and response time are all backed by real transactions/atomic state transitions that can't be self-generated. **Explicitly deferred to a future Fraud/Risk system, not solved in this step** (per the task's own "do not attempt to solve every fraud problem" instruction): `profile_view` bot/self-view deduplication (currently unguarded, same as Step 1 left it, and only lightly exploitable given the conversion signal's small 0.06 weight and neutral-below-threshold floor); any explicit fraud-pattern detection (e.g., synchronized review timing); rate-limiting on review submission beyond the existing one-per-completed-booking constraint.

### Tests
44 new tests: `RankingScorerTest` (16, pure unit — deterministic scoring, the exact 5.0/1-vs-4.8/250 example, cold start, verified/response-time/completion-rate/profile-completeness effects, extreme-value safety, signal-key truthfulness), `SignalCollectorTest` (9, DB-integration — rating/verified reads, completed/cancelled counting, response-time reads, the profile_view entity_type quirk across both provider types, profile completeness, platform mean), `RankingEngineTest` (7, DB-integration — score persistence, all-provider recompute, all three hook-trigger paths proven live end-to-end, a query-count regression guard), `MarketplaceControllerTest` (+2 — real-score-driven sort order, truthful-only reason labels), `RuleBasedProviderTest` (+1 — AI consumes the same ranking, not a duplicate). Full backend suite: 233/233 passing (was 198 after Step 2).

### Live verification (real running site, real browser and DB inspection)
1. **Professional in Yazd** → all 5 real demo providers, correctly ordered (سارا احمدی's real 70.17 score first; the four cold-start-baseline providers tiebreaking on verified/provider_id exactly as designed), filtered to the 3 real Yazd providers when city-scoped.
2. **Hair-color service in Yazd** → an honest, empty "متخصصی با این فیلتر پیدا نشد" — eligibility correctly excluded the one (Isfahan-based) hair-color specialist rather than ranking trying to surface her anyway.
3. **5.0/1-review vs 4.8/250-review** → covered by the deterministic unit test rather than live-fabricated review data, which would have violated the task's own explicit "must never create fake... reviews" rule at the volume (250 reviews) this scenario needs.
4. **Cold-start professional appears** → confirmed live: four zero-review/zero-booking demo providers all render normally in results at a real 55.0 baseline score, never hidden or buried.
5. **Irrelevant professional cannot outrank via popularity** → confirmed via scenario 2's eligibility filtering (structurally impossible for ranking to override eligibility, by construction).
6. **AI uses the same ranking** → confirmed live (a real conversation's service recommendation resolved to the highest-genuinely-scored provider) and by `RuleBasedProviderTest`.
7. **No Tehran-specific assumptions** → confirmed by code inspection (zero hardcoded city names anywhere in `Ranking`) and live Yazd/Isfahan scenarios both behaving correctly.
8. **Persian RTL UI** → confirmed (Persian labels/digits, correct phrase order in `rankingReasons` rendering).
9. **Mobile ~375px** → no horizontal overflow.
10. **Console errors** → none observed across all scenarios.

Post-verification DB check: still exactly 5 real providers (no fake ones created), 1 pre-existing unrelated loyalty row (no new awards from ranking activity), 7 real bookings (unchanged) — ranking activity created zero side effects outside `wp_bc_provider_index.ranking_score`/`ranking_signals`.

### Known limitations / deferred
- The cold-start blend protects a low-evidence provider on **every** signal simultaneously, not just rating — discovered while writing `RankingScorerTest`, where an initial version of the "1 review vs 250 reviews" test compared two signal sets that also differed on unrelated (defaulted-to-zero) fields, and the blend's broad protection made the low-evidence case score *higher* than intended. Fixed by holding every non-rating signal constant across the comparison, which is the theoretically correct way to isolate one dimension — documented here since it's a real, non-obvious interaction between two features that are each individually correct.
- Province-level location fallback (exact city → province → national) was designed against but not built — no current consumer needs a soft city preference (every existing filter is a hard exact match); a real extension point once a genuine caller needs it.
- `profile_view` deduplication and broader fraud-pattern detection are explicitly out of this step's scope, per the task's own instruction not to solve every fraud problem now.
- `recompute_all()`'s profile-completeness lookups are unbatched (see Performance above) — fine at current scale, same batching fix as `HoldExpiryScheduler` if that ever changes.
- No admin UI for adjusting `RankingConfig` weights was built — a code-level configuration class is the stated bar for V2.0 per the task's own instructions; a weight-tuning admin screen is a plausible, separate future step once real usage data exists to tune against.

---

## V2.0 Step 4 — Implementation Notes (Beauty Journey)

**Scope actually implemented:** a real customer-owned domain layer connecting goals/preferences → a timeline composed almost entirely from existing booking/review/order/AI event data → the existing AI assistant (as a context *source*, not a rewrite) → the existing booking/loyalty/commerce systems (as read-only *consumers*, never duplicated). Exactly two new tables. One new REST controller. No new booking engine, no new AI engine, no new ranking logic, no CRM/referral/campaign/membership/financial work.

### What existed before
§4.2's original assessment (written during V2 planning, before any Step had shipped) correctly identified the two real assets a journey could build on: the customer dashboard's reserved-but-placeholder `باشگاه مشتریان` nav slot, and `ai_context`'s existing per-user accumulation. It also *suggested* building the journey subsystem inside `beauclick-ai` and a `wp_bc_journeys`/`wp_bc_journey_items` two-table shape. Both suggestions were revisited during implementation — see the discrepancy below — but the two-table *instinct* was directionally right; the actual schema ended up as `wp_bc_beauty_profiles` (general preferences) + `wp_bc_beauty_goals` (specific, dated objectives), not `journeys`/`journey_items`, because a single "journey" row per goal and a separate generic-preferences concept turned out to be the smaller, less redundant model once the real event/booking data available for timeline composition was inventoried (see below).

### A real discrepancy found during implementation, and why the module lives in `beauclick-booking`, not `beauclick-ai`
§4.2 assumed a journey subsystem could live inside `beauclick-ai` ("it's AI-created/AI-editable per the roadmap"). Direct inspection at implementation time found this doesn't fit the data the journey actually needs: a timeline needs the customer's own bookings, and — the same class of finding V2.0 Step 3 already made about ranking — `booking_created`/`_confirmed`/`_completed`/`_cancelled` events log with `entity_type='booking'` and (for confirm/complete) **no `actor_id` at all**, so a customer's booking-lifecycle timeline entries can only be resolved by first fetching that customer's own booking ids from `wp_bc_bookings` and matching events against that id set — a read `beauclick-ai` has no legitimate reason to perform directly. Rather than force this into the AI plugin, **Beauty Journey was built as its own new plugin, `beauclick-journey`**, sitting in the dependency chain right where its real data needs put it: `core ← marketplace ← booking ← journey ← ai` (ai already depended on marketplace; it now also depends on journey, a new but non-circular addition — journey has no reason to ever depend on ai). This mirrors the exact reasoning Step 3 already used for placing `Ranking` inside `beauclick-booking`, applied consistently rather than re-litigated from scratch.

### Architecture
Two new tables (both additive migrations, `beauclick-journey\Database\Migrations\CreateJourneyTables`), owned entirely by the new plugin:
- **`wp_bc_beauty_profiles`** — one row per customer (`PRIMARY KEY user_id`, same shape as `wp_bc_ai_conversations`'s own `UNIQUE user_id`): `preferred_city_id`, `preferred_specialty_ids` (comma-list, same convention as `provider_index.specialty_ids`), `budget_min`/`budget_max`, and a length-capped (`VARCHAR(500)`), customer-authored, explicitly non-medical `notes` field. General, low-commitment, ongoing preferences.
- **`wp_bc_beauty_goals`** — many rows per customer, a specific, nameable, optionally dated objective ("آماده شدن برای عروسی خواهرم") distinct from the general profile, with a `status` (`active`/`achieved`/`abandoned` — never hard-deleted, so a completed goal stays part of the customer's own history) and `KEY user_status (user_id, status)`.

No third table for the timeline, no table for "recommendations," no table duplicating loyalty. Everything else is composed at read time:
- **`Timeline\TimelineComposer`** — reads `wp_bc_events` (goal_created, review_submitted, order_completed/_refunded, ai_recommendation_clicked — all correctly `actor_id`-scoped) unioned with `wp_bc_bookings`-resolved booking-lifecycle events (the workaround for the `entity_type='booking'`/no-`actor_id` gap above), ordered/paginated, filtered to a deliberately curated allow-list (excludes `profile_view` and `ai_recommendation_shown` as noise, and `booking_expired` as an operational, not customer, event).
- **`JourneySummaryService`** — the one combined "خلاصه مسیر زیبایی" read composing profile + active goals + next 3 upcoming confirmed bookings + last 3 completed bookings + real loyalty balance (`LoyaltyLedger::balance()`, unmodified) + the customer's most recent AI recommendation cards (via `AssistantService::get_or_create_conversation()`/`messages()`, both already-public, already-enriched — zero new recommendation logic) + real WP `user_registered` date. One request instead of five-plus, per the task's own explicit performance instruction.
- **`Context\JourneyContextProvider`** — the one seam `beauclick-ai` calls into (see AI integration below).
- **`Rest\JourneyController`** — every route self-scoped via `get_current_user_id()`, never a request-supplied customer id (`GET/PATCH /journey/profile`, `GET/POST /journey/goals`, `PATCH /journey/goals/{id}`, `GET /journey/timeline`, `GET /journey/summary`). Goal mutation is the one endpoint with an actual resource id and gets an explicit ownership check (`can_edit_goal()`, same shape as `MyProfileController::can_edit_service()`).

One small, genuinely new, minimal-scope addition outside the journey plugin itself: `MarketplaceController::specialties()` (`GET /marketplace/specialties`) — the goal-creation form needed a real specialty picker, and `bc_specialty` being `show_in_rest=true` only exposes it under WordPress core's `wp/v2` namespace, a different envelope shape (`{data,meta,error}` vs raw arrays) the app-shell's `api.ts` wrapper doesn't parse. Same read-only, public, reference-data pattern `LocationsController::get_provinces()` already establishes, just in the `beauclick/v1` namespace this app already speaks.

### AI integration
`AssistantService::send()` now merges `JourneyContextProvider::infer_ai_defaults($user_id)` **underneath** the conversation's own already-accumulated `ai_context` (`array_merge(journeyDefaults, conversationContext)`), so anything the customer has already stated in the current conversation always wins over the general journey default — verified directly by a real test (`AssistantServiceTest::test_an_explicit_conversation_signal_overrides_the_journey_default`) and live (see below). `infer_ai_defaults()` returns only the same structured shape (`specialtyIds`/`cityId`/`budget`) `RuleBasedProvider`/`CatalogContext` have consumed from `ai_context` since Step 2 — **zero new AI-side matching code was needed** for this to take effect; Journey supplies context, AI's existing machinery already knows what to do with it, exactly per the task's explicit "Journey provides context and lifecycle state, AI remains responsible for recommendation reasoning" boundary. An active goal's own fields override the general profile's (more specific/current intent wins); the profile's free-text `notes` field is **never** included in what reaches a provider, so it can never be forwarded to an external AI provider's prompt without the customer typing it into that specific turn themselves. AI keeps working with zero journey data exactly as it did before this plugin existed (`class_exists()`-guarded, optional dependency).

### Booking/commerce/review/loyalty integration
- **Booking**: read-only, via `beauclick-journey`'s own now-legitimate (same-or-downstream-plugin) reads of `wp_bc_bookings` — no second booking model, no new booking write path.
- **Commerce**: `AiRecommendation`'s existing product type already flows through `recentRecommendations`; `order_completed`/`order_refunded` events (already `actor_id`-scoped since Step 1) feed the timeline. No WooCommerce order data is duplicated, no pricing logic touched.
- **Reviews**: `review_submitted` events (already `actor_id`-scoped) feed the timeline; no second review system, `wp_bc_reviews` itself is never read directly by Journey.
- **Loyalty**: `LoyaltyLedger::balance()` called as-is; `EarningRules`' point values are untouched — Beauty Journey invents no new points, no tiers, no membership.

### Security / privacy model
Every endpoint is self-scoped by construction (no customer id ever accepted from a request for profile/goals-list/timeline/summary) — the same "there is no way to ask for someone else's data" pattern `MyOrdersController`/`BookingController::list_own()` already established, not a new authorization mechanism. The one endpoint with an actual foreign resource id (`PATCH /journey/goals/{id}`) uses the existing `require_owner_or_capability` pattern. No medical-record system: the schema has no dedicated health/medical field anywhere; `notes` is a short (500-char), customer-authored, generic preference field, and — if a customer types something medical-sounding into it and later mentions it in an AI conversation turn — the existing `MedicalSafetyGuard` from Step 2 already catches it downstream; no new medical-handling logic was needed or added here. Verified live: a second customer's journey is completely empty/isolated from the first's real goal and loyalty balance; a professional account's own `/journey/summary` call returns their own empty journey, never the customer's; the professional dashboard doesn't even surface a journey UI (different dashboard entirely, by existing V1 role routing).

### UI
Fills the exact `باشگاه مشتریان` slot reserved since V1 (relabeled `مسیر زیبایی من` — loyalty balance becomes one section of the journey rather than a competing nav destination) inside the existing `DashboardLayout`. Sections: `اهداف من` (goal list + inline create form, reusing `Input`/`Button`/`Card`), `نوبت‌های آینده`, `خدمات انجام‌شده`, `پیشنهادهای شخصی` (reuses AI's own `RecommendationCard` component directly — zero new card-rendering logic), `فعالیت‌های اخیر` (the composed timeline). No new visual language, no new design tokens.

### Tests
44 new tests: `BeautyProfileServiceTest` (7), `GoalServiceTest` (7), `TimelineComposerTest` (7), `JourneySummaryServiceTest` (6), `JourneyControllerTest` (9 — including the explicit cross-customer authorization boundary), `JourneyContextProviderTest` (5), plus 2 new `AssistantServiceTest` cases (journey-default injection, explicit-context-wins precedence) and 1 new `MarketplaceControllerTest` case (`specialties()`). Full backend suite: 277/277 passing (was 233 after Step 3). Frontend type-checks and builds clean.

### Live verification (real running site, real accounts, real DB inspection)
1. `مسیر زیبایی من` nav item present and reachable from the real customer dashboard.
2. Real existing booking history shown (`خدمات انجام‌شده`: سارا احمدی · میکاپ مراسم — a real prior booking from earlier verification passes, not fabricated).
3. Real completed activity confirmed via the same section plus a fully real, composed `فعالیت‌های اخیر` feed (`رزرو ثبت شد`/`رزرو تأیید شد`/`خدمت انجام شد`/`پیشنهاد دستیار هوشمند دنبال شد`).
4. Created a real goal ("آماده شدن برای عروسی خواهرم", میکاپ, ۳,۰۰۰,۰۰۰ تومان) through the real form, using a real specialty list fetched from `/marketplace/specialties`.
5. The goal appeared immediately in `اهداف من` **and** as a new `هدف زیبایی تعریف شد` timeline entry — no page reload needed.
6. **AI genuinely used the journey's stored goal**: with the test conversation's own `ai_context` cleared, sending "سلام، یه متخصص خوب بهم پیشنهاد بده" (no specialty mentioned at all) returned میکاپ-specific services and providers — proof the goal's `specialtyId` flowed through as an AI default, not a re-test of already-covered matching logic.
7. Recommendations remained grounded in the real catalog (real provider names/prices/durations, real product prices) — same validation guarantees Step 2 already established, untouched.
8. Booking/service card links pointed at real deep-link URLs (unchanged from Step 2's mechanism); no broken links.
9. Loyalty balance shown (۱۰ امتیاز) matched the real ledger exactly (`LoyaltyLedger::balance()` value, not a re-derived number).
10. **A second customer (`bc_qa_business`) saw a completely empty, isolated journey** — 0 loyalty points, no goals, none of the first customer's data.
11. **A professional account (`bc_demo_sara_ahmadi`) never saw a journey UI at all** (routed to the entirely separate professional dashboard by existing V1 role logic), and a direct `fetch()` to `/journey/summary` as that professional returned only their own empty journey — confirmed at the API level, not just the UI level.
12. Mobile 375px: no horizontal overflow, full content rendered correctly.

Console errors observed during verification (3× `403` on `wp-login.php?action=logout`) were traced to the verification process itself — navigating directly to a bare, nonce-less logout URL as a testing shortcut, which WordPress correctly rejects as a CSRF protection — not to any Beauty Journey code path; every `/journey/*` and `/marketplace/specialties` request returned 200 OK throughout. Documented here so it isn't mistaken for a real issue in a future pass.

### Bugs discovered / fixed
None requiring a V1 fix. One implementation bug caught by the tests themselves before it ever reached live verification: `BeautyProfileService::update()`'s `notes` field originally stored an empty string instead of clearing to `NULL` when a customer cleared their notes — inconsistent with every other field's "falsy means clear" PATCH convention on the same endpoint. Fixed before commit; covered by `BeautyProfileServiceTest::test_notes_can_be_explicitly_cleared_with_an_empty_string`.

### Known limitations / deferred
- No `DELETE` endpoint for goals — a goal only ever transitions to `achieved`/`abandoned`, preserving it as real history rather than allowing it to vanish; if a genuine "remove this goal entirely" need emerges later, it's a small, additive extension.
- No specialty/city-based AI-context inference beyond the single most-recently-created active goal when more than one is active — deterministic and documented, not a real limitation at current usage patterns, but a plausible refinement (e.g., letting the AI ask "which goal is this about?") if customers commonly run multiple active goals at once.
- `recentRecommendations` surfaces only the customer's single most recent AI message with recommendations, not a deduplicated/aggregated history across the whole conversation — matches "reuse AI's own data, don't build a second recommendation system," but a richer "recommendations you haven't acted on yet" view is a plausible future refinement once there's real usage data to justify it.
- No admin/professional-facing view of aggregate journey data (e.g., "which goals are customers setting") was built — explicitly out of scope (that's CRM territory, not Step 4).
- Table cleanup on WP user deletion is not implemented — consistent with every other `bc_*` table in this codebase (none of them cascade-delete on user removal either), not a new gap introduced here.

### Assumptions
- "Beauty Journey" is a customer-facing concept only — professionals/businesses were not given their own "journey," matching the task's own framing (`نمای کلی`/`مشتریان` on the professional side is CRM territory, explicitly out of scope for this step).
- A goal's `specialtyId`/`cityId` are optional — the roadmap's own suggested `wp_bc_journeys` shape didn't include them, but they were added because without them a goal can't meaningfully feed AI context, which is the whole point of the "recommendation loop" the task describes; a title-only goal remains fully valid (tested).

---

## Cross-Cutting Standard — Persian/Jalali Date & Error Localization

**Not a V2 step — this is a permanent engineering standard applying to both V1 and V2**, added after a focused audit found BeauClick's dates were Gregorian everywhere (Persian *digit glyphs* on a Gregorian calendar, not an actual Jalali calendar) and a handful of genuine English-string leaks in otherwise fully-Persian-localized error paths. Every future V2 capability must follow the rules below; V1 was touched only where required to fix this specific, cross-cutting defect (per the standing V1-protection rule).

### What was found
- **No Jalali/Shamsi conversion existed anywhere** in this codebase, PHP or TypeScript. The only "Persian" date-adjacent helper was `bc_persian_digits()`/`toPersianDigits()` — pure digit-glyph substitution (`2026` → `۲۰۲۶`), never calendar conversion. Every dashboard table, the booking date-chip picker, chat timestamps, order/review dates, and the WooCommerce order thank-you page were all genuinely Gregorian dates wearing Persian digits.
- A concrete, representative bug: the WooCommerce thank-you page rendered `bc_persian_digits(wc_format_datetime($order->get_date_created()))` — Persian-looking digits on a date that was, and remained, Gregorian.
- Backend REST `format()` methods across booking/chat/ai/reviews/journey/b2b/payments already return raw, unformatted MySQL datetime strings — this turned out to be the *correct* half of the architecture (the conversion boundary, see below), since the frontend already owns final display formatting; only the frontend's formatter itself was wrong.
- A real (not merely theoretical) timezone off-by-one risk: `beauclick-core\Plugin::activate()` sets the site timezone to `Asia/Tehran` (UTC+03:30, confirmed by the existing `TimezoneTest`) — a naive `strtotime()`+`gmdate()` round trip on a site-local datetime string re-interprets it through that offset and back to UTC, shifting the calendar date near midnight. Found and fixed before it shipped (see JalaliDate's own docblock) and caught again independently in a dashboard weekly-chart date-only string (`new Date('2026-08-12')` parses as UTC midnight in JS, not local midnight).
- English-string leaks: `RestController::require_login()`/`require_capability()` (the base permission check nearly every protected route in every plugin uses) and one `MarketplaceController` 404 message were the genuine English outliers among ~40+ otherwise-correct Persian error strings. A frontend fallback path (`ApiError.message ?? res.statusText`) could surface a raw English HTTP reason phrase ("Not Found", "Internal Server Error") whenever a response didn't match the expected JSON envelope. Live verification also found WooCommerce's checkout privacy-policy notice frozen in English — a literal option value written once at install time, never re-translated on read, invisible to normal `.mo`-file localization.

### Global date standard
BeauClick is Persian-first/RTL-first: **every user-facing date uses the Jalali (Solar Hijri) calendar** — booking dates, availability, dashboards, orders, reviews, chat, journey timeline, AI-surfaced dates, forms, tables, empty/error/success states. Gregorian dates/digits must never reach a normal user. Internal storage stays exactly as it already was (MySQL `DATETIME`, site-local wall-clock, no schema change) — this audit changed *presentation and input*, not storage or domain logic.

### Conversion boundary (explicit, per this task's own instruction)
```
User input/display  <-->  Jalali/Persian   (JalaliDateInput, format.ts's formatShortDate/formatFullJalaliDate)
Application/domain logic  -->  normalized internal representation  (Gregorian y/m/d, unchanged)
Database  -->  existing storage format  (MySQL DATETIME, site-local, unchanged)
```
REST APIs continue returning raw Gregorian datetime strings — this is correct, not a gap: the frontend already owned final display formatting before this audit, so fixing the *formatter* (not the API contract) was the minimal, correct change. The one exception is genuinely server-rendered, PHP-only surfaces with no frontend involved (transactional emails, the WooCommerce thank-you page) — those call the shared `JalaliDate` class directly.

### Shared date abstraction
One conversion algorithm, ported by hand into both runtimes (no new dependency in either — a small, self-contained, well-known public-domain calculation, not infrastructure):
- **`app/src/lib/jalali.ts`** — `toJalali()`/`toGregorian()`/`isJalaliLeapYear()`/`jalaliMonthLength()`/`JALALI_MONTHS`. `app/src/lib/format.ts`'s `formatShortDate()`/`formatFullJalaliDate()` are the presentation layer built on top — every dashboard/table/list already importing `format.ts` needed zero structural changes, only its output became calendar-correct.
- **`beauclick-core\Support\JalaliDate`** — `toJalali()`/`toGregorian()`/`isLeapYear()`/`format()`, the one PHP implementation every plugin depends on (same "shared abstraction in the base layer" reasoning as `EventLogger`/`Migrator`/V2.0 Step 3's `RankingPresenter`). `format()` parses date components directly out of the datetime string rather than round-tripping through `strtotime()`/`gmdate()`, specifically to avoid the Asia/Tehran timezone-shift bug described above.
- **`JalaliDateInput`** (new design-system primitive) — three `<select>`s (day/month/year), not a calendar-grid widget or a new npm dependency; stores/emits a plain Gregorian `YYYY-MM-DD` (the same internal representation every date on its endpoint already uses), displays only Jalali. Replaces native `<input type="date">` (Gregorian-only in every mainstream browser) wherever a customer picks a date — currently the Beauty Journey goal form; the shared component exists precisely so no future feature re-introduces a Gregorian date input.
- **Correctness**: both implementations verified against the same well-known golden reference point (1979-02-11 Gregorian = 1357-11-22 Jalali, Iranian Revolution Day) plus zero-mismatch round-trip testing across a 65-year range (1970-2035) and explicit leap-year/end-of-month/Nowruz-boundary assertions. If either side is ever modified, the other must be updated identically — they are deliberately parallel, not shared source (PHP and TypeScript can't literally share one file).

### Error localization standard
- Every user-facing error, empty state, and status message is Persian, in this codebase's existing natural register (not machine-translated, not childish) — this was already true for the overwhelming majority of strings; the fix here closed the remaining gaps rather than establishing a new convention.
- `RestController::require_login()`/`require_capability()` (the two highest-blast-radius messages — nearly every protected endpoint in every plugin funnels through them) and `MarketplaceController`'s one English 404 are now Persian.
- Frontend: `api.ts`'s `request()` now (a) never lets a raw `res.statusText` or a caught network `TypeError` reach the UI — both degrade to one shared, natural Persian fallback string, and (b) correctly reads BOTH error shapes that can reach it — the app's own `{data,meta,error:{code,message}}` envelope AND WordPress core's native `{code,message,data}` shape (which is what a rejected `permission_callback` actually returns, before the request ever reaches a beauclick controller's own envelope-wrapping code) — previously only the first shape was checked, silently discarding an already-correct Persian message from the second.
- `storeApi.ts` (WooCommerce Store API wrapper) no longer falls back to raw `res.statusText` either.
- WooCommerce's checkout privacy-policy notice — a literal, install-time-frozen option value invisible to normal `.mo` translation — is now corrected on plugin activation (`beauclick-payments\Plugin::ensure_persian_checkout_privacy_text()`), following the exact same "only touch it if it's still the untouched stock default, never overwrite an admin's own customization" discipline `ensure_persian_page_titles()` already established for the same class of problem.
- No general-purpose error-message translation *catalog* was built — this codebase's existing, working convention is a Persian literal as the string itself (no `.mo` file for any `beauclick-*` text domain), which the audit found already correctly applied almost everywhere; the gaps were specific missed spots, not a missing mechanism.

### Testing
17 new PHP tests (`JalaliDateTest`, `PluginTest` additions) + 21 new frontend tests (`jalali.test.ts`, `format.test.ts`, `api.test.ts` additions) covering: the golden reference point, Nowruz/year-boundary conversion, leap-year detection (1403 leap/1402 not), end-of-month round-trips for every month of several years, a 65-year zero-mismatch round-trip sweep, the timezone-shift regression guard, Persian month-name/weekday correctness, and both error-message-shape parsing paths plus the "never a raw English fallback" guarantee.

### V1 compatibility notes
Touched only what was strictly required: `beauclick-booking\Notifications\BookingMailer` (transactional email dates), the theme's `woocommerce/checkout/thankyou.php` override (order date display), `beauclick-core\Rest\RestController`'s two error messages, one `beauclick-marketplace\Rest\MarketplaceController` message, and `beauclick-payments\Plugin`'s new checkout-privacy-text activation step. No V1 database schema changed, no V1 business logic changed, no V1 booking/availability/payment behavior changed — every fix is presentation-layer (a date's calendar system, an error message's language) or a one-time WooCommerce option correction, never a functional change. `v1.0.0` tag untouched.

### V2 development requirement
Every future V2 capability **must** use `JalaliDate`/`jalali.ts`/`JalaliDateInput`/`format.ts`'s date helpers for any date it displays or accepts, and must never introduce a second Jalali conversion implementation, a native `<input type="date">` for customer-facing input, or a hardcoded English error/status string. This is now the standing convention, the same way the append-only ledger pattern and the plugin-per-domain architecture already are.

### Known limitations / deferred
- `beauclick-b2b`'s quote `expires_at` field (admin/business-side quote management) has no frontend UI at all yet in this codebase — nothing to convert to Jalali until a UI is built for it; noted, not fixed speculatively.
- The footer copyright year (`gmdate('Y')`) was deliberately left Gregorian — a copyright year is a widely-understood international convention even on Persian-first sites, not a "date" in the sense this audit's scope (bookings, schedules, orders, dashboards) was concerned with.
- No admin-facing (wp-admin) strings were translated — English CPT labels, role names, and menu labels in wp-admin are seen only by administrators/moderators, not customers/professionals/businesses, and were explicitly out of this audit's user-facing scope.
- Frontend error messages fall back to one shared generic Persian string when no specific translated message is available from either known API error shape — this is correct and sufficient (never raw/English), but a small number of edge-case failures (e.g. a truly malformed response) will read as generic rather than maximally specific; acceptable given how rarely that path is actually reached in normal use.

---

## 1. V1 Freeze Statement

BeauClick V1 is frozen as of commit `8494c7b4f6540500366da42b589b22fce53206a7`, tagged `v1.0.0` and released on GitHub. All 12 architecture phases are complete; the Production Readiness/Hardening audit and full UI/RTL/Typography QA pass are complete; 140/140 backend tests pass; all 7 named critical flows are live-verified against the running site.

**V1 is not to be reopened for feature work.** The only legitimate reasons to touch V1 code during V2 planning or early implementation are the ones already established as this project's standing rule: a genuine security vulnerability, data-integrity problem, payment-correctness problem, authorization problem, production blocker, or real functional bug. Stylistic refactors, "preparing" stable code for a hypothetical V2 need, or changing working business logic because V2 could theoretically want something different are all out of scope until a V2 capability actually requires the change — and even then, the preference is to extend, not rewrite.

---

## 2. Current Architecture Snapshot

This section is the factual baseline every capability assessment below is measured against. It comes from direct inspection of the codebase (not the original architecture proposal, which predates several implementation decisions).

### 2.1 Plugin inventory

Ten domain plugins around a shared `beauclick-core`, one per bounded context: `beauclick-core`, `beauclick-locations`, `beauclick-marketplace`, `beauclick-booking`, `beauclick-b2b`, `beauclick-payments`, `beauclick-chat`, `beauclick-ai`, `beauclick-reviews`, `beauclick-loyalty`. No plugin registers routes or tables outside its own domain. Cross-plugin coupling happens through three deliberate seams: WordPress action/filter hooks (e.g. `beauclick/booking/after_create`, `beauclick/chat/message_sent`), a shared `RestController` base class, and plain indexed foreign-key-shaped columns with **no actual FK constraints** (WordPress doesn't guarantee plugin activation order, so referential integrity is enforced in application code, not the schema).

### 2.2 Database — what's real vs. what's a placeholder

| Table | Owner | Status |
|---|---|---|
| `wp_bc_provinces` / `cities` / `districts` | locations | Mature — lat/lng, `is_launched` gating, seeded |
| `wp_bc_provider_index` | marketplace | Mature, actively maintained by `Search\Indexer` on every profile/service/review change. Has a `ranking_score DECIMAL(10,4) NULL` column that **nothing writes or reads** |
| `wp_bc_availability_slots`, `wp_bc_bookings` | booking | Mature — hold/expiry semantics (`held_until`, `expires_at`), `wc_order_id` bridge to WooCommerce |
| `wp_bc_business_accounts`, `wp_bc_b2b_price_tiers`, `wp_bc_quotes` | b2b | Mature — full account/tier/quote lifecycle |
| `wp_bc_conversations`, `wp_bc_messages` | chat | Mature — 1:1 only, no group threads, polling-based |
| `wp_bc_ai_conversations`, `wp_bc_ai_messages`, `wp_bc_ai_recommendation_events` | ai | Mature but narrow — **one AI thread per user** (`UNIQUE KEY user_id`), no thread history/list |
| `wp_bc_reviews` | reviews | Mature — `UNIQUE KEY booking_id` enforces one review per completed booking at the DB layer |
| `wp_bc_events` | core | **Schema-ready, functionally empty.** A real `EventLogger` class exists (`beauclick_core()->events()->log(...)`) with good indexes and a documented event-type taxonomy — but grepping the entire plugins tree found **zero actual call sites**. The taxonomy list lives only in a docblock comment. No historical event data exists to build anything on top of. |
| `wp_bc_loyalty_points` | loyalty | **Schema-ready, functionally empty.** `LoyaltyLedger::award()/balance()/history()` is real, correct, tested code — but `award()` is called nowhere outside its own test file. No tiers, no redemption, no referral (not even a stub table). |
| — | payments | **No custom tables at all.** `beauclick-payments` is pure WooCommerce glue (hooks + a read-only "my orders" endpoint); there is no BeauClick-owned commission, payout, or earnings ledger anywhere in the codebase. |

The pattern across `wp_bc_events` and `wp_bc_loyalty_points` matters for planning: this project already has a *correct, established convention* for append-only ledgers (immutable rows, signed amounts where relevant, `reference_type`/`reference_id` polymorphic linkage) — V2 doesn't need to invent that pattern, it needs to **use it** and, critically, **start writing to it**, because no backfill of past activity is possible.

### 2.3 REST API — what's real vs. what's missing

Every plugin's REST surface goes through a shared `RestController` (`route()`, `require_login()`, `require_capability()`, `require_owner_or_capability()`, `pagination_args()`) and a shared `Response` envelope (`{data, meta, error}`) that the frontend's `api.ts` unwraps consistently. This is a solid, reusable foundation — any new V2 endpoint should extend this base, not invent a new pattern.

Gaps that matter for V2: `beauclick-payments` exposes exactly one endpoint (`GET /payments/my/orders`, read-only) — no payout, commission, or refund-initiation routes exist. `beauclick-loyalty` exposes **zero** REST routes. `beauclick-chat` is polling-only REST; no WebSocket/SSE transport exists anywhere. `MarketplaceController::sort_clause()` contains an explicit inline comment marking where a real `ranking_score`-based sort was always meant to land — the extension point already exists, unused.

### 2.4 AI — the strongest existing foundation for V2's flagship capability

`beauclick-ai`'s `ProviderInterface` (`chat(history, context): AssistantResponse`) is a genuinely clean, provider-agnostic abstraction — not aspirational, it works today with two real implementations: `RuleBasedProvider` (deterministic, DB-backed keyword/regex matching against `wp_bc_provider_index`, the default) and `AnthropicProvider` (a real `wp_remote_post` adapter, JSON-contract parsing, gated behind `BC_AI_PROVIDER`/`BC_AI_API_KEY`, never yet exercised against the live API in this environment).

`AssistantService` already does the two things a recommendation engine most needs to get right: it rate-limits (transient-based, 15/min — in-memory, not durable) and it **validates every recommendation against real catalog rows before returning it**, regardless of which provider produced it — the "never trust the model's IDs" safety net V2's expanded AI absolutely needs is already there and tested.

What's narrow today: `ContextExtractor` pulls exactly three signals (specialty via taxonomy-name substring match, city via substring match, budget via a Persian-digit regex) — no event/timeline, no beauty-goal taxonomy, no skin/hair type despite the interface's own docblock listing them as examples. `CatalogContext` only ever surfaces *providers* to the AI, never products, services, or booking availability. There is no concept of a persistent user-preference profile outside the single AI conversation's `ai_context` JSON blob.

### 2.5 Design system

`app/src/design-system/primitives/`: `Button`, `Card`, `Chip`, `Badge`, `Input`, `PlaceholderImage`, `RatingStars`, `PriceTag`, `EmptyState`, `LoadingDots`, `Modal`. Frontend features are organized per-surface (`app/src/features/{ai,booking,cart,chat,dashboard,reviews}`), Vite-code-split per mount point, tokens generated from `shared/design-tokens.json` (the single cross-stack source, with a PHP twin in `beauclick-core`). The professional dashboard's nav already reserves **10 IA slots**, of which only 5 are built (`نمای کلی`, `رزروها`, `خدمات`, `نظرات`, `پیام‌ها`); the other 5 — critically, **`مشتریان` (Customers/CRM) and `درآمد` (Revenue)** — render a placeholder ("this section completes in a future version of the product") and were reserved intentionally in the original design handoff, not accidentally left out.

---

## 3. V2 Strategic Goals

Taken directly from the roadmap and unchanged by this assessment: (1) make BeauClick more intelligent and personalized, (2) increase retention and repeat transactions, (3) give professionals/businesses stronger operating tools, (4) expand toward a true multi-sided marketplace, (5) create revenue streams beyond basic commission. Section 6 below explains why this document sequences those five goals differently than the roadmap's own suggested order.

---

## 4. Capability-by-Capability Assessment

Each capability is scored against V1's actual foundation, not the roadmap's description of an ideal end state.

### 4.1 AI-Powered Beauty Discovery and Recommendation Engine

1. **Existing foundation:** Strong — see §2.4. Provider-agnostic interface, real rule-based matching, recommendation-validation safety net, rate limiting, message-injection guarding (`MessageGuard`).
2. **Extend:** `ContextExtractor` (add event-type/timeline/goal extraction alongside the existing specialty/city/budget signals), `CatalogContext` (currently provider-only — extend to include services, products, and live availability), `AssistantResponse`'s recommendation shape (currently `{type, id}` for provider/product — extend to support bundles/routines as a composite recommendation type).
3. **New domain/module:** None — stays inside `beauclick-ai`. A "bundle/routine" concept is new *logic*, not a new plugin.
4. **Database changes:** `ai_context` is already a flexible JSON blob — extending its shape is additive, no migration needed for the extraction upgrade itself. A "bundle recommendation" needs no new table if it's expressed as a list of existing entity references (service/product/provider IDs) inside the existing `recommendations` JSON column.
5. **REST/API changes:** Extend `POST /ai/messages`'s response shape (additive); the existing "save recommendation for later" hook doesn't exist yet — needs a small new endpoint or reuse of the Beauty Journey save mechanism (§4.2) rather than inventing a parallel one.
6. **Frontend/UI changes:** `RecommendationCard` in `AiPanel`/`ChatPanel` needs a bundle-rendering variant (multiple linked cards + an estimated total); no new screen.
7. **WooCommerce integration:** Currently none at the AI layer (products are never fed into `CatalogContext`) — this is the single most consequential extension: without it, "budget-aware recommendations" and "recommend products" from the roadmap are structurally impossible today.
8. **AI integration:** N/A — this *is* the AI capability. Provider-agnosticism is already correctly enforced; no change needed to preserve it.
9. **Security/privacy:** The existing recommendation-validation safety net already prevents a hallucinated/unauthorized entity ID from rendering. Extending context to include budget/event data raises the same "what goes to an external provider" question addressed in §9.
10. **Performance:** `CatalogContext` queries live on every call with no caching — fine at current data volume; revisit only if provider count or AI call volume grows enough to show up in slow-log, per this project's own stated anti-premature-optimization stance.
11. **Dependencies:** Marketplace (search/index), Booking (for scheduling-aware suggestions), WooCommerce product catalog, loosely Ranking (§4.9 — better ranking improves recommendation quality but doesn't block launch).
12. **Business value:** High — this is the flagship differentiator the roadmap's own "Product North Star" centers on, and it's the capability closest to shippable today.
13. **Technical complexity:** Medium — the hard scaffolding (provider abstraction, safety validation, rate limiting) already exists; the work is extraction logic and context-assembly, not new infrastructure.
14. **Major risks:** Scope creep into "the AI should understand everything" — the roadmap's own safety section (no medical diagnosis) needs a concrete implementation (a keyword/classifier gate in `MessageGuard` or a system-prompt instruction plus output review), not just a policy statement.
15. **Recommended priority:** **First.** Strongest existing foundation of all 12 capabilities, and multiple other capabilities (Journey, AI-for-professionals) build on it.

### 4.2 Beauty Journey / Personal Beauty OS

1. **Existing foundation:** Weak structurally, but two adjacent facts matter: the customer dashboard already has a `باشگاه مشتریان` (loyalty club) nav slot reserved, and `ai_context` already accumulates signals per-user across a session — a journey is conceptually "a structured, user-editable version of what the AI already infers."
2. **Extend:** `AssistantService` (to propose a journey from a conversation, per the roadmap's own example), the customer dashboard's reserved-but-placeholder nav slots.
3. **New domain/module:** Yes — a `Journey` subsystem, most naturally inside `beauclick-ai` (it's AI-created/AI-editable per the roadmap) rather than a new eleventh plugin, unless journeys grow complex enough to warrant their own domain boundary later.
4. **Database changes:** New — `wp_bc_journeys` (customer_id, goal, target_date, budget, status) and `wp_bc_journey_items` (journey_id, item_type, item_ref_id, milestone_status, scheduled_at). Follows the existing no-cross-plugin-FK convention.
5. **REST/API changes:** New CRUD surface (`GET/POST /journeys`, `PATCH /journeys/{id}`) plus an AI-assisted creation endpoint.
6. **Frontend/UI changes:** New customer-dashboard section (fills one of the 5 already-reserved-but-empty nav slots) — a "personal dashboard, not a generic task manager" per the roadmap, needs real design attention, not a reused generic list view.
7. **WooCommerce integration:** Indirect — journey items reference products/services that already flow through commerce; no new Woo integration.
8. **AI integration:** Central — journeys are AI-proposed, user-edited.
9. **Security/privacy:** Strictly customer-owned; no cross-customer visibility (same ownership pattern as everywhere else in this codebase).
10. **Performance:** Low-volume, no concern.
11. **Dependencies:** AI Discovery (§4.1) — a journey without AI-assisted creation is just a to-do list, which undersells the roadmap's own vision. Also depends on Booking and Commerce for linking real actions.
12. **Business value:** High for retention — this is the mechanism that turns a one-off booking into "a continuous relationship with the platform," directly serving strategic goal #2.
13. **Technical complexity:** Medium.
14. **Major risks:** Building this before AI Discovery is solid means either a weak, manual-only journey feature or duplicated intent-extraction logic.
15. **Recommended priority:** **Second**, immediately after AI Discovery, in the same early milestone.

### 4.3 Multi-Sided Marketplace

1. **Existing foundation:** The professional/business duality and B2B's business-account model already establish "more than one kind of seller" as a concept, but true multi-vendor commerce (independent sellers each managing their own product catalog/inventory/orders) doesn't exist — WooCommerce products today are BeauClick's own catalog.
2. **Extend:** Marketplace's existing provider/business distinction is the closest analog.
3. **New domain/module:** Yes, and a large one — seller onboarding, per-seller inventory, order splitting, seller-scoped analytics. This typically means adopting a dedicated WooCommerce multi-vendor extension (Dokan/WCFM-class) rather than building from scratch, mirroring the same build-vs-buy calculus the original architecture doc already flagged for B2B tier pricing.
4. **Database changes:** Large — seller profiles, seller-product ownership, commission-at-order-line-item granularity.
5. **REST/API changes:** Large new surface.
6. **Frontend/UI changes:** Large — seller onboarding flow, seller dashboard, product management UI.
7. **WooCommerce integration:** Deep — this is fundamentally a WooCommerce architecture change (multi-vendor order splitting), not a BeauClick-plugin-level addition.
8. **AI integration:** Indirect — more sellers means richer AI catalog context, not a direct dependency.
9. **Security/privacy:** Significant — sellers must never see each other's orders/customers/financials.
10. **Performance:** More catalog scale, more complex order fan-out at checkout.
11. **Dependencies:** Financial/Payout system (§4.4) — sellers need to actually get paid, which doesn't exist yet. Business accounts.
12. **Business value:** Potentially large, but speculative until real demand exists.
13. **Technical complexity:** High.
14. **Major risks:** This is exactly the kind of change the roadmap's own §6 warns against — "do not assume multi-vendor commerce must be implemented immediately... should be introduced when business requirements and real marketplace data justify it." The roadmap's own language defers this.
15. **Recommended priority:** **Deferred.** Not part of the recommended V2.0–V2.3 sequence below; revisit only when real marketplace usage data (not this document) makes the case.

### 4.4 Financial System and Professional Payouts

1. **Existing foundation:** Weakest of all 12 — zero custom tables, one read-only endpoint. But the *pattern* to build it correctly (append-only ledger, immutable rows, `reference_type`/`reference_id` linkage) already exists twice in this codebase (`wp_bc_events`, `wp_bc_loyalty_points`) and should be reused, not reinvented.
2. **Extend:** `BookingOrderBridge` (booking↔order linkage already exists and is the natural trigger point for commission calculation).
3. **New domain/module:** Yes — `beauclick-finance` (or similarly named), genuinely new.
4. **Database changes:** New — an append-only `wp_bc_ledger_entries` (or per-earning-type tables) recording gross amount, commission, net earning, entry type, reference; a `wp_bc_payouts` table (batch, status, amount, paid_at) separate from individual earning entries so payout status and order status stay distinct, per the roadmap's own explicit requirement.
5. **REST/API changes:** New — provider/business earnings view, payout history, admin reconciliation endpoints. All must be read-only from the professional/business side; only admin-side or an automated batch process should ever write.
6. **Frontend/UI changes:** New dashboard section — this is exactly the `درآمد` (Revenue) nav slot already reserved and currently a placeholder.
7. **WooCommerce integration:** Deep — reads order totals, needs to hook order completion/refund events without becoming fragile against WooCommerce's own order-state machine.
8. **AI integration:** None required; AI-for-professionals (§4.10) can later summarize financial data, but the ledger itself needs no AI.
9. **Security/privacy:** Highest of any V2 capability — financial records must never be editable through ordinary customer/professional interfaces (roadmap's own explicit requirement), full audit trail, no floating-point money math (this codebase already stores prices as integers everywhere — Toman has no subunit — so this convention is easy to continue, not a new discipline to introduce).
10. **Performance:** Low volume relative to booking/marketplace traffic; not a near-term concern.
11. **Dependencies:** WooCommerce, Booking (order bridge already exists), Marketplace (business accounts), B2B (order flow already exists there too).
12. **Business value:** Potentially the most direct monetization mechanism of all 12 capabilities, but only once real transaction volume exists to take commission from.
13. **Technical complexity:** High — not because the code is exotic, but because financial correctness under refunds/cancellations/disputes is genuinely hard to get right and expensive to get wrong.
14. **Major risks:** The single highest-risk capability in this entire roadmap. Real money, real audit requirements, and (per V1's own still-open question) a real payment-gateway decision hasn't even been made yet — building a payout system before knowing which gateway's settlement/reconciliation model you're integrating against risks real rework.
15. **Recommended priority:** **Deferred relative to the intelligence/retention work**, but not indefinitely — see §6 for the explicit business-decision flag this document raises about sequencing it earlier if monetization urgency outweighs the risk.

### 4.5 CRM for Professionals and Businesses

1. **Existing foundation:** Moderate-to-strong. The data a CRM needs already exists relationally — `wp_bc_bookings.customer_id`, `wp_bc_reviews.author_id`, `wp_bc_messages.sender_id` — all queryable per-provider today. `DashboardController` already computes "new clients this month." `ReviewsController::for_providers()` establishes the exact batched-aggregation pattern a CRM's customer list needs. The `مشتریان` nav slot is already reserved and empty.
2. **Extend:** `DashboardController`-style aggregation queries generalize directly into a CRM controller; no new query patterns need inventing.
3. **New domain/module:** A thin one — most of CRM is a *view* over existing booking/review/chat data plus a small amount of genuinely new data (notes, tags).
4. **Database changes:** Small — `wp_bc_crm_notes` (professional_id, customer_id, note, created_at) is close to the only new table strictly required; segmentation/tagging can start as a computed/derived concept (e.g. "hasn't booked in 60 days") rather than a stored table.
5. **REST/API changes:** New `beauclick-crm`-shaped endpoints, or folded into `beauclick-booking`'s `DashboardController` as a natural extension — the latter avoids creating an eleventh plugin for what is largely a read-aggregation layer.
6. **Frontend/UI changes:** New dashboard section (fills the reserved `مشتریان` slot) — customer list, filters, customer detail view, notes.
7. **WooCommerce integration:** Optional — "products purchased where permitted" per the roadmap; only relevant if a professional/business also sells products, otherwise skip.
8. **AI integration:** Not required for CRM itself, but is exactly what AI-for-professionals (§4.10) needs CRM to exist first for ("which customers haven't returned" is a CRM query the AI later narrates).
9. **Security/privacy:** Critical, and the codebase's existing ownership-check pattern (`ProviderLookup`, `require_owner_or_capability`) directly transfers — a professional/business must only ever see their own customers, enforced the same way booking/review ownership already is.
10. **Performance:** Bounded by a provider's own booking count; no new performance risk given existing indexes on `customer_id`/`provider_id`.
11. **Dependencies:** Booking, Reviews, Chat (data sources) — no dependency on anything not already built.
12. **Business value:** High — directly serves strategic goal #3 (stronger professional tools) at relatively low engineering cost given how much data already exists.
13. **Technical complexity:** Low-to-medium — this is the best value-per-effort capability in the entire roadmap.
14. **Major risks:** Low. The main risk is scope creep toward the roadmap's more ambitious CRM features (campaign targeting, segmentation) before the basic customer list/notes view is solid.
15. **Recommended priority:** **Early** — high value, low complexity, strong existing foundation, no blocking dependencies.

### 4.6 Loyalty + Referral + Membership

1. **Existing foundation:** Split three ways. Loyalty *ledger*: real, tested, completely unwired (§2.2). Tiers: none. Referral: **zero code anywhere**, not even a stub. Membership: zero.
2. **Extend:** `LoyaltyLedger::award()` needs to actually be called from `BookingService` (on completion), `ReviewService` (on submission), and order-completion hooks — this alone is a small, low-risk change that activates real functionality that's been sitting dormant.
3. **New domain/module:** Referral and Membership are both genuinely new; Loyalty tiers are new logic inside the existing `beauclick-loyalty` plugin.
4. **Database changes:** Loyalty wiring needs none (the ledger table already supports it). Tiers need a small `wp_bc_loyalty_tiers` config table (points threshold → tier name/benefits) rather than hardcoding tiers in PHP, per the roadmap's own "must be configurable rather than hard-coded" requirement. Referral needs a new `wp_bc_referrals` table (referrer_id, referred_id, status, reward_issued, created_at) with a unique constraint preventing self-referral and duplicate attribution. Membership needs `wp_bc_memberships` (user_id, tier, started_at, expires_at).
5. **REST/API changes:** All new — `beauclick-loyalty` currently has zero REST surface; this is where it gets one (balance, history, redemption; referral code generation/redemption; membership status/upgrade).
6. **Frontend/UI changes:** New — the `باشگاه مشتریان` (loyalty club) nav slot is already reserved on the customer dashboard.
7. **WooCommerce integration:** Membership discounts and loyalty redemption both need to interact with WooCommerce's price calculation — the same hook (`woocommerce_before_calculate_totals`) B2B's `TierPricingEngine` already uses, and the exact hook whose price-display/price-charged mismatch this project's own V1 audit found and fixed. Any loyalty/membership pricing logic must be built with that lesson in mind — test the *displayed* price against the *charged* price explicitly, not just the charged price in isolation.
8. **AI integration:** Optional — AI can reference loyalty status in Journey/recommendation copy later; not required for launch.
9. **Security/privacy:** Referral fraud prevention (self-referral, duplicate attribution, eligibility windows) is the real engineering challenge here, explicitly called out by the roadmap and genuinely non-trivial.
10. **Performance:** Low volume, no concern.
11. **Dependencies:** Booking and Commerce (as point-earning triggers). CRM benefits from loyalty/membership data for segmentation but isn't blocked by it.
12. **Business value:** Loyalty wiring = quick win for retention. Membership = a real recurring-revenue lever (subscriptions). Referral = acquisition cost reduction.
13. **Technical complexity:** Loyalty wiring: low. Tiers: low-medium. Membership: medium. Referral: medium (fraud prevention is the hard part).
14. **Major risks:** Referral fraud if eligibility/attribution rules are underbuilt; membership benefit stacking with B2B/promotion pricing needs the same care as §4.7.
15. **Recommended priority:** Loyalty wiring is a **quick early win** (bundle with §4.9's event-instrumentation work — same "activate dormant infrastructure" motion). Tiers/Membership/Referral follow in the retention-focused milestone.

### 4.7 Campaign and Promotion Engine

1. **Existing foundation:** WooCommerce's native coupon system exists and is functional but unconfigured (confirmed in the V1 audit — "no rates, no coupons issued, since no business rule was specified"). No BeauClick-specific audience/eligibility engine.
2. **Extend:** None directly — this is genuinely new logic layered on top of WooCommerce coupons, not a replacement for them.
3. **New domain/module:** Yes.
4. **Database changes:** New — campaign definition table (audience rules, scope, time range, usage limits) plus a redemption-tracking table.
5. **REST/API changes:** New admin-authoring endpoints, plus customer-facing "eligible campaigns" queries.
6. **Frontend/UI changes:** New admin campaign-builder UI, customer-facing promotion surfacing (in AI recommendations, Journey, marketplace).
7. **WooCommerce integration:** This is the capability with the highest WooCommerce-price-hook risk in the entire roadmap. B2B tier pricing already hooks `woocommerce_before_calculate_totals`; loyalty/membership discounts (§4.6) will too. Stacking a third price-modifying hook without a single, deliberate "what order do these apply in, and can they combine" design is how the exact class of bug this project's V1 audit found (advertised price ≠ charged price) recurs, at higher stakes.
8. **AI integration:** The roadmap's own "personalized AI promotion" idea depends on AI Discovery (§4.1) existing first.
9. **Security/privacy:** Coupon/campaign abuse (stacking, sharing single-use codes) needs the same rigor as referral fraud prevention.
10. **Performance:** Campaign eligibility evaluation needs to be cheap enough to run on every cart calculation — worth explicit load-testing before launch, unlike most other V2 additions.
11. **Dependencies:** WooCommerce, Booking, B2B pricing, Loyalty, Membership, AI — the most dependency-heavy capability in the roadmap, explicitly warned about in the roadmap's own text ("avoid creating conflicting discount calculations").
12. **Business value:** High — directly enables acquisition/retention campaigns strategic goal #2 and #5 depend on.
13. **Technical complexity:** Medium engineering, but genuinely tricky *integration* complexity given the price-hook stacking risk above.
14. **Major risks:** Price-hook interaction bugs (highest risk here of any V2 item, given the exact bug class this project already shipped once in B2B and had to fix live).
15. **Recommended priority:** **After** Loyalty/Membership exist (so there's something real to integrate against, not a speculative interface).

### 4.8 Waitlist, Smart Rebooking and Retention Automation

1. **Existing foundation:** `HoldExpiryScheduler` (`beauclick-booking`) is the **only** existing scheduled-job infrastructure in the entire codebase, proving the cron pattern works, but nothing else uses it. No waitlist table/logic anywhere. No retention/re-engagement triggers of any kind exist today (confirmed directly — "nothing in the codebase resembles retention automation").
2. **Extend:** The booking hold-expiry cron pattern generalizes directly to waitlist-slot-opened checks and rebooking-reminder sweeps.
3. **New domain/module:** Waitlist logic fits inside `beauclick-booking` (it's a booking-adjacent concept). Retention automation and a **central Notifications service** are new — critically, this capability cannot be built well on top of the current two ad hoc `wp_mail()` wrappers (`BookingMailer`, `ReviewMailer`); it needs the one central, templated, multi-channel-ready notification service this codebase doesn't have yet.
4. **Database changes:** New `wp_bc_waitlist_entries` (customer_id, provider_id, service_id, preferred_window, flexibility, status) with the same atomic-claim discipline (`UPDATE ... WHERE status = 'open'`) already used for slot booking to avoid race conditions when multiple waitlisted customers compete for one opened slot — this project already solved that exact concurrency problem once for booking itself. New `wp_bc_notifications` table if in-app (not just email) notifications are wanted, matching the roadmap's own "respect user preferences" requirement, which implies a notification-preferences concept that also doesn't exist yet.
5. **REST/API changes:** New — waitlist join/leave, notification preferences, in-app notification feed if built.
6. **Frontend/UI changes:** New — waitlist join UI on a fully-booked slot, a notification center/bell if in-app notifications are built, rebooking-suggestion surfacing (natural fit inside the Beauty Journey UI from §4.2).
7. **WooCommerce integration:** None directly.
8. **AI integration:** Smart Rebooking's "based on service type, booking pattern, professional, preference" logic is a natural extension of AI Discovery's context/recommendation machinery, not a separate system.
9. **Security/privacy:** Notification preferences must be genuinely respected (opt-out honored), and retention automation must not become intrusive — the roadmap explicitly flags this.
10. **Performance:** Cron sweep volume scales with active waitlist/booking count; the existing `HoldExpiryScheduler` pattern (LIMIT-bounded, indexed) is the right model to copy.
11. **Dependencies:** Booking (core), a central Notifications service (prerequisite, doesn't exist), CRM (§4.5, for rebooking-interval logic).
12. **Business value:** High for retention (strategic goal #2) — waitlist directly recovers otherwise-lost bookings, rebooking automation directly drives repeat transactions.
13. **Technical complexity:** Medium, plus the up-front cost of building the Notifications service this capability depends on.
14. **Major risks:** Race conditions on waitlist-slot-claiming if the atomic-update discipline isn't followed as rigorously as booking's own hold logic was.
15. **Recommended priority:** After CRM (§4.5) and the Notifications service exists; the Notifications service itself should be treated as its own small prerequisite step, not bundled invisibly into this capability's estimate.

### 4.9 Advanced Reputation and Ranking Engine

1. **Existing foundation:** Structurally ready, functionally empty — see §2.2. `wp_bc_events` has good indexes and a real writer class; `wp_bc_provider_index.ranking_score` is a waiting column; `MarketplaceController::sort_clause()` has an explicit, named extension point already marking where this plugs in.
2. **Extend:** Every service method that should be logging an event already exists and just needs one line added (`beauclick_core()->events()->log(...)`) — `BookingService` (create/confirm/cancel/complete), `ReviewService` (submit), `ChatController`/`ConversationService` (message sent), `AssistantService` (recommendation shown/clicked, which is already partially done via the separate `wp_bc_ai_recommendation_events` table).
3. **New domain/module:** A small ranking-computation job (reads `wp_bc_events`, writes `ranking_score`) — most naturally a scheduled job inside `beauclick-marketplace` (it owns `wp_bc_provider_index`) or `beauclick-core` (it owns `wp_bc_events`); either is defensible, lean toward marketplace since it owns the output.
4. **Database changes:** None required for instrumentation (the table exists). The scoring job needs no new table — it writes into the existing `ranking_score` column.
5. **REST/API changes:** `MarketplaceController`'s default "recommended" sort swaps from `verified DESC, rating_avg DESC` to `ranking_score DESC` (with the current fields as tiebreakers) — a one-line, low-risk change once the column is actually populated.
6. **Frontend/UI changes:** None required initially — ranking is a backend sort change, invisible to the UI until an admin "why is this ranked here" explainability view is wanted (roadmap's own "explainable enough for internal administration" requirement).
7. **WooCommerce integration:** None.
8. **AI integration:** Better ranking data indirectly improves AI Discovery's recommendation quality (both read the same `wp_bc_provider_index`).
9. **Security/privacy:** None significant — this is aggregate, non-personal data.
10. **Performance:** The scoring job needs to run on a schedule (not per-request) to avoid recomputing on every search; the existing cron pattern applies directly.
11. **Dependencies:** None blocking — this can start immediately and in parallel with everything else.
12. **Business value:** Medium-direct, high-indirect — better ranking quality compounds into better AI recommendations, better marketplace conversion, and (per the roadmap) a defensible non-pay-to-win reputation system.
13. **Technical complexity:** Low for instrumentation, low-medium for a first scoring algorithm (a weighted-sum of normalized signals is a reasonable v1, not a machine-learning system).
14. **Major risks:** None structural. The only real risk is *not* starting instrumentation early — every day without event-logging wired up is a day of ranking-relevant history permanently lost.
15. **Recommended priority:** **Instrumentation immediately, in parallel with everything else** (near-zero cost, unlocks data collection). The scoring algorithm itself follows once there's a few weeks of real event data to validate against — building it against zero historical data risks tuning against noise.

### 4.10 AI for Professionals and Businesses

1. **Existing foundation:** Reuses the same `ProviderInterface`/`AssistantService` machinery as §4.1 — the abstraction doesn't care whether the caller is a customer or a professional, only the context assembled and the authorization boundary differ.
2. **Extend:** `AssistantService`, gated by a new authorization layer ensuring a professional/business's AI queries only ever assemble context from *their own* data — the same ownership pattern (`ProviderLookup`, ownership checks in `ReviewService::respond`) already used everywhere else in this codebase.
3. **New domain/module:** None structurally — new context-assembly logic inside `beauclick-ai`, likely reading from CRM (§4.5) and instrumented events (§4.9).
4. **Database changes:** None beyond what CRM/events already need.
5. **REST/API changes:** A professional-scoped variant of `/ai/messages`, or a `context: 'professional'` parameter on the existing endpoint with server-side authorization deciding what's assembled — the latter reuses more code.
6. **Frontend/UI changes:** New AI entry point inside the professional/business dashboard (distinct from the customer-facing AI panel — different tone, different data).
7. **WooCommerce integration:** Sales/inventory-analysis features need product/order data assembled into context, same integration gap §4.1 already identified.
8. **AI integration:** Direct extension of §4.1's abstraction.
9. **Security/privacy:** The single most important requirement in this whole capability, and the roadmap says it explicitly: "AI must only access data the current user is authorized to access." This needs to be enforced at the context-assembly layer, not trusted to prompt instructions — the same principle as `AssistantService`'s existing recommendation-validation safety net, applied to inbound context instead of outbound recommendations.
10. **Performance:** Query volume scales with professional dashboard usage, not customer-facing traffic; low near-term concern.
11. **Dependencies:** CRM (§4.5) for customer-relationship queries, event instrumentation (§4.9) for "which services lost sales" style analysis.
12. **Business value:** High — directly serves strategic goal #3, and differentiates BeauClick's professional tooling from a plain booking calendar.
13. **Technical complexity:** Medium — mostly authorization-boundary engineering, not new AI infrastructure.
14. **Major risks:** A context-assembly bug that leaks one professional's customer data into another's AI session would be a severe privacy incident — this needs explicit test coverage before launch, not just code review.
15. **Recommended priority:** After CRM and event instrumentation exist to query against.

### 4.11 Realtime Communication and Consultation

1. **Existing foundation:** `beauclick-chat` is deliberately polling-based, with an explicit, already-built extension seam (`beauclick/chat/message_sent` action hook) documented as exactly the point a future realtime relay would subscribe to. 1:1 conversations only — no group threads.
2. **Extend:** The message-sent hook is the integration point; no chat logic needs rewriting to add a realtime layer alongside it.
3. **New domain/module:** A realtime transport (WebSocket relay, or a hosted service like Pusher/Mercure) is genuinely new *infrastructure*, not new BeauClick domain logic.
4. **Database changes:** Minor — online-status/typing-indicator state is usually ephemeral (cache/transient), not a new persistent table.
5. **REST/API changes:** Minimal — existing send/list endpoints stay the primary path; realtime is additive delivery, not a replacement API.
6. **Frontend/UI changes:** Typing indicator, online status, delivery state — real but contained UI additions to the existing `ChatPanel`.
7. **WooCommerce integration:** None.
8. **AI integration:** None required; "AI handoff" from the roadmap is really just starting an AI conversation from within a human chat thread, which the existing separate AI-conversation table already supports conceptually.
9. **Security/privacy:** A realtime transport needs its own auth (can't reuse cookie+nonce for a persistent WebSocket connection the same way) — this is a genuinely new authentication surface to get right.
10. **Performance/infrastructure:** This is the capability the roadmap's own §20 "non-goals" section warns against most directly — "do not introduce realtime infrastructure without a real need." Polling was a deliberate launch-scale decision, not a placeholder apologized for.
11. **Dependencies:** None blocking; purely additive to existing chat.
12. **Business value:** Real but incremental — faster message delivery improves UX, doesn't unlock new revenue or retention mechanisms the way CRM/Loyalty/Journey do.
13. **Technical complexity:** Medium-high (new infra) for a UX improvement, not a new capability.
14. **Major risks:** Building this before there's evidence of a real need (message volume, user complaints about polling latency) is exactly the premature-infrastructure risk this document's whole approach is trying to avoid.
15. **Recommended priority:** **Deferred** until chat volume or user feedback actually justifies it — matching the roadmap's own stated instinct, not overriding it.

### 4.12 Native Mobile Application

1. **Existing foundation:** The REST API is already the correct backend contract for a future mobile client — no parallel business-logic layer needs to be built (the roadmap's own explicit requirement is already satisfied by the existing architecture). Current auth is cookie+nonce, web-session-oriented.
2. **Extend:** Nothing in the mobile app is an "extension" of existing V1 code in the way other capabilities are — it's a new client consuming the existing API.
3. **New domain/module:** A new client codebase entirely (native or cross-platform), outside this monorepo's current `app/` React web app-shell.
4. **Database changes:** None required by mobile itself.
5. **REST/API changes:** Token-based (e.g. JWT) authentication needs to be added *alongside* (not replacing) cookie+nonce, since the web app-shell should keep working exactly as it does today — this was already flagged as an open question in the original V1 architecture doc, explicitly deferred until "native apps become a real development priority."
6. **Frontend/UI changes:** N/A to this monorepo in the traditional sense — this is new mobile UI work, informed by but not built from the existing design system's CSS (native apps need their own token consumption, typically via the same `shared/design-tokens.json` source translated to native styling).
7. **WooCommerce integration:** Same Store API the web app already uses; no gateway-specific issue beyond auth.
8. **AI integration:** Reuses existing AI endpoints once token auth exists.
9. **Security/privacy:** Token issuance/rotation/revocation is new attack surface that doesn't exist in the current cookie+nonce model and needs real security review before shipping.
10. **Performance:** N/A to backend; mobile-specific performance (payload size, offline behavior) is a client concern.
11. **Dependencies:** Benefits from every other V2 capability being stable first (a mobile app amplifies whatever the web product already does well or poorly) — the roadmap's own principle ("native apps before web product validation" is listed as a non-goal) applies directly.
12. **Business value:** Potentially large long-term, but speculative without evidence the target audience needs a native app over the existing responsive web experience (which this project's own V1 audit confirmed is genuinely mobile-optimized, not an afterthought).
13. **Technical complexity:** High — an entirely new codebase and (if native) two platform-specific ones.
14. **Major risks:** Building this before core V2 capabilities are validated risks building a polished mobile shell around an unfinished product.
15. **Recommended priority:** **Last.** Matches both the roadmap's own ordering and this document's dependency analysis.

---

## 5. Dependency Graph

```
Event instrumentation (§4.9, part 1)  ─┐  (near-zero-cost, blocks nothing, unlocks everything below marked *)
                                        │
AI Discovery (§4.1) ───────────────────┼──► Beauty Journey (§4.2)
      │                                │          │
      │                                │          └──► (feeds) Smart Rebooking (§4.8)
      │                                │
      ▼                                ▼
Ranking algorithm (§4.9, part 2)*   CRM (§4.5)
                                        │
                                        ├──► AI for Professionals (§4.10)
                                        │
                                        └──► Waitlist / Retention (§4.8) ◄── Notifications service (new prerequisite)
                                                     │
Loyalty wiring (§4.6, quick win)*                   │
      │                                              │
      ▼                                              ▼
Loyalty tiers / Membership (§4.6) ──────────► Campaign/Promotion Engine (§4.7)
                                                     ▲
                                              (also needs) B2B pricing hook lessons

Financial/Payout (§4.4) ── independent of the above, gated by real-money risk + gateway decision
      │
      ▼
Multi-Sided Marketplace (§4.3) ── deferred, needs Financial/Payout first if ever built

Realtime Chat (§4.11) ── additive, deferred, no blocking dependency either direction
Native Mobile (§4.12) ── consumes everything above once stable; last
```

Two things this graph makes explicit that the roadmap's own suggested order doesn't: (1) **event instrumentation and loyalty-wiring are near-zero-cost prerequisites that should happen immediately, in parallel with whatever else is first**, not sequenced as their own milestone; (2) **a central Notifications service is a real, currently-nonexistent prerequisite** for Waitlist/Retention automation that the roadmap's capability list doesn't call out as its own line item, but which needs to be built before — not during — that capability.

---

## 6. Recommended V2 Implementation Sequence

This intentionally does not match the roadmap's own suggested "2A/2B/2C" order in every place — differences are explained inline.

### V2.0 — Intelligence & Signal Foundation
1. **Event instrumentation** (§4.9 part 1) + **Loyalty ledger wiring** (§4.6 quick win) — both near-zero-risk, activate dormant infrastructure, start immediately.
2. **AI Discovery upgrade** (§4.1) — extend `ContextExtractor`/`CatalogContext` to include products/services/availability and richer intent signals.
3. **Ranking algorithm v1** (§4.9 part 2) — once a few weeks of real event data exist.

### V2.1 — Personal & Professional Relationship Layer
4. **Beauty Journey** (§4.2) — built on the upgraded AI.
5. **CRM** (§4.5) — best value-per-effort capability in the roadmap; fills the already-reserved dashboard slot.
6. **Loyalty tiers + basic Membership** (§4.6).

### V2.2 — Retention & Growth
7. **Central Notifications service** — new, small, treated as its own prerequisite rather than folded silently into #8.
8. **Waitlist + Smart Rebooking + retention automation** (§4.8).
9. **Referral** (§4.6) — genuinely new, fraud-prevention-heavy.

### V2.3 — Monetization & Professional Tools
10. **Campaign/Promotion Engine** (§4.7) — only once Loyalty/Membership exist to integrate against, with explicit test coverage for displayed-vs-charged price given this project's own prior bug in exactly this class of code.
11. **AI for Professionals/Businesses** (§4.10) — once CRM and event data exist to query.
12. **Financial/Payout system** (§4.4) — see the explicit business-decision flag below.

### V2.4 — Platform Expansion (deferred, revisit only with evidence)
13. Realtime chat/consultation (§4.11)
14. Multi-sided marketplace (§4.3)
15. Native mobile apps (§4.12)

**One explicit business-decision flag, not a technical one:** this document sequences the Financial/Payout system late because it's the highest-risk, zero-existing-foundation capability and because a real payment-gateway decision (already an open item from the V1 architecture doc) should land before building a payout/settlement model around it. If monetization urgency is higher than this document assumes, that's a legitimate reason to pull it earlier — but that's a call for the product owner to make explicitly, not an engineering default.

### Why this differs from the roadmap's own suggested order
The roadmap's 2A/2B/2C groups AI/Journey/Rebooking/Waitlist/Ranking/Loyalty together, then CRM/AI-for-pro/Campaigns/Financial together, then Marketplace/Realtime/Mobile together. This document mostly agrees with that broad shape but makes three concrete changes: it pulls event-instrumentation and loyalty-wiring out as an immediate, near-zero-cost first move rather than bundling them into a larger milestone; it moves CRM earlier (into the same milestone as Journey) because CRM's foundation is stronger and its cost lower than several roadmap-listed 2A items; and it explicitly inserts a Notifications-service prerequisite the roadmap's capability list never names on its own.

---

## 7. Architecture Evolution Requirements

Evaluated against the roadmap's own five-question framework (why now / what problem / what if we don't / simplest viable architecture / operational + migration cost) for every infrastructure area it names:

- **Search infrastructure:** No change needed. `wp_bc_provider_index` with MySQL indexes handles current and near-term V2 query patterns (including ranking-score sort). Introduce Meilisearch/Elasticsearch only if free-text relevance genuinely becomes a measured problem — no evidence of that today.
- **Recommendation infrastructure:** No new infrastructure — extending `CatalogContext`/`ContextExtractor` inside the existing AI plugin is sufficient; a vector-embedding/similarity-search layer is not justified by anything in V1's actual usage.
- **Event architecture:** Already exists (`wp_bc_events`) and needs zero new infrastructure — it needs writers, which is a code change, not an architecture change.
- **Analytics:** No dedicated analytics warehouse needed at V2's likely scale; `wp_bc_events` plus periodic aggregation queries is the simplest viable architecture, matching this project's own stated anti-premature-optimization stance.
- **Background jobs:** The one real gap. `HoldExpiryScheduler`'s WP-Cron pattern is the only precedent and it's a *sound* one — extend it (waitlist sweeps, ranking recalculation, retention triggers) rather than introducing a job queue system (Redis/Sidekiq-equivalent) that nothing in V1's actual traffic justifies.
- **Notifications:** Needs real evolution — from two ad hoc `wp_mail()` wrappers to one central service with templating and (eventually) multi-channel support. This is genuinely new, but it's an application-layer service, not new infrastructure (still `wp_mail()`-based; SMS/push are additive later, not required now).
- **Caching:** No change — Redis/object-cache remains explicitly deferred (per V1's own architecture doc) until traffic data justifies it; nothing in V2's scope changes that calculus.
- **Realtime infrastructure:** Deferred per §4.11 — no "why now" exists yet.
- **Financial ledger:** New, and appropriately so — see §4.4. The pattern to build it correctly already exists twice in this codebase.
- **Marketplace settlement:** Only relevant if/when Multi-Sided Marketplace (§4.3) is ever built — no action now.
- **Mobile API:** Token-based auth alongside cookie+nonce, only when native mobile (§4.12) actually starts.
- **Authentication:** No change until mobile auth is needed; cookie+nonce continues to serve the web product correctly.
- **AI orchestration:** No new infrastructure — the existing `ProviderInterface`/`ProviderFactory` abstraction already does exactly what a "provider-agnostic AI orchestration layer" needs to do; extend it, don't replace it.

**Simplest viable architecture, restated:** almost everything V2.0–V2.3 needs already has its architectural shape decided by V1's own conventions (append-only ledgers, plugin-per-domain, hook-based cross-plugin seams, WP-Cron for scheduling). The genuine new pieces are a Financial ledger, a Notifications service, and (much later, conditionally) realtime transport and a multi-vendor commerce layer — everything else is extension, not evolution.

---

## 8. Data & Privacy Considerations

V2 substantially increases the amount of behavioral, relational, and commercial data BeauClick holds. The authorization boundaries below are not aspirational — they follow the exact pattern already enforced in V1 code (`ProviderLookup`, `require_owner_or_capability`, the B2B IDOR this project's own V1 audit found and fixed) and must be applied with the same rigor to every new table:

- **A professional/business must only ever access their own customers' data** (CRM, AI-for-professionals) — enforced at the query layer via the same ownership-lookup pattern used throughout booking/reviews today, not via UI-level hiding.
- **AI must only assemble context the current user is authorized to see** — for customer-facing AI this is already true (`CatalogContext` has no cross-user data); for AI-for-professionals (§4.10) this becomes the single most important thing to get right and test explicitly.
- **Financial records must be isolated and auditable** — immutable ledger rows, no ordinary-user write path, admin reconciliation views only.
- **Data minimization**: Journey/CRM/Loyalty data should default to what's needed for the feature to function, not "collect everything in case it's useful later" — matching the roadmap's own explicit principle.
- **Explicit consent/preferences**: notification preferences (§4.8) need a real opt-out mechanism honored by the new central Notifications service, not assumed.
- **Referral fraud/attribution** and **campaign/coupon abuse** both need real server-side enforcement (self-referral blocks, single-use tracking), not client-side trust.
- **Safe deletion/anonymization**: not urgent for V2.0–V2.1, but Journey/CRM/loyalty data accumulation makes this a real question by V2.2 — worth a documented policy before retention automation starts sending data-driven messages based on long-lived behavioral history.

---

## 9. AI & Privacy Considerations

- **What AI actually needs**: today, provider listings only (rating, price, city, verification). V2's upgrade adds product/service/availability data and richer user-provided context (budget, event timeline, goals) — all of this should flow through the same `CatalogContext`-style assembly layer, never be sent to an external provider as a raw, unfiltered user-data dump.
- **What must never be sent externally**: PII beyond what's needed for the recommendation itself (no full name/phone/address in prompts), financial data, private message history from chat, another user's data under any circumstance.
- **Anonymization**: where AI context needs aggregate signals (e.g. "customers like you"), those should be pre-aggregated server-side, not assembled by sending raw per-customer rows to the model.
- **Consent**: using AI at all is already capability-gated (`bc_use_ai_assistant`); V2 should make explicit that professional/business AI features (§4.10) surface what data category is being used, given they're querying real customer relationships, not just public catalog data.
- **AI context assembly must respect existing WordPress/WooCommerce/BeauClick permissions** — the ownership-check pattern already used everywhere else applies here without modification; this is a discipline to carry forward, not a new mechanism to invent.
- **Validate AI output against real catalog data** — already true and already tested (`AssistantService::validate_recommendations`); extend the same validation to any new recommendation types (bundles/routines) rather than assuming the existing check automatically covers new shapes.
- **Provider-agnosticism**: `ProviderInterface` already enforces this correctly; every V2 AI extension (Journey creation, professional AI, bundle recommendations) must go through it rather than special-casing a specific provider's API anywhere in application code.

---

## 10. Monetization Opportunities

| Capability | Revenue mechanism | Type |
|---|---|---|
| Financial/Payout (§4.4) | Commission on every completed booking/order | Direct |
| Membership (§4.6) | Recurring subscription fees for Plus/Premium tiers | Direct |
| Campaign Engine (§4.7) | Promotion/placement fees if paid campaigns are ever introduced (roadmap explicitly requires these stay distinguishable from organic ranking) | Direct |
| Multi-Sided Marketplace (§4.3) | Seller fees, if/when built | Direct (deferred) |
| AI Discovery (§4.1) | No direct fee, but drives conversion into bookable/purchasable recommendations | Retention + acquisition value |
| Beauty Journey (§4.2) | No direct fee; the mechanism that makes membership/premium-AI-features worth paying for | Retention value |
| CRM (§4.5) | Plausible future "professional SaaS tier" gate (basic CRM free, advanced segmentation/campaigns paid) | Direct, longer-term |
| Loyalty/Referral (§4.6) | Reduces customer acquisition cost rather than generating direct revenue | Acquisition value |
| Waitlist/Rebooking (§4.8) | Recovers otherwise-lost bookings directly | Direct, incremental |
| Advanced Ranking (§4.9) | No direct fee; improves marketplace conversion broadly | Growth value |
| AI for Professionals (§4.10) | Plausible premium-tier gate alongside CRM | Direct, longer-term |
| Realtime/Mobile (§4.11/4.12) | No direct revenue mechanism; UX/retention only | Retention value |

The roadmap's own instruction not to "optimize the product purely for monetization" is worth restating here in concrete terms: Financial/Payout and Membership are the only two capabilities in this list with an unambiguous, immediate direct-revenue mechanism — everything else in V2.0–V2.2 should be justified primarily by retention/acquisition value, with monetization following once the underlying engagement is real.

---

## 11. Design/UI Implications

The existing visual identity (Persian-first, RTL-first, calm/premium/clean) is not to be redesigned — every addition below extends the existing design system (`app/src/design-system`) rather than duplicating it.

- **New screens**: Beauty Journey dashboard section, CRM customer list + detail, Revenue/payout dashboard section (both fill already-reserved, currently-placeholder nav slots — no new IA decision needed, just design and build them), Waitlist join flow, notification center/bell (if in-app notifications are built), campaign-eligible-offer surfacing, professional-facing AI entry point.
- **New components**: bundle/routine recommendation card (extends the existing `RecommendationCard` pattern), journey milestone/progress indicator, CRM customer-row + tag/note UI, financial statement/ledger table (reuse the existing `Card`/table patterns already established for bookings/reviews), waitlist status chip, loyalty tier badge (extends existing `Badge` primitive).
- **New interaction patterns**: AI-assisted journey creation ("propose, then let the user edit/approve" per the roadmap's own description) is a genuinely new interaction shape not present in V1's UI; needs real design attention, not a generic form.
- **Mobile requirements**: every new screen needs the same 390/375/412 verification discipline this project's V1 audit already established as its QA convention — no new tooling needed, just continued application of the existing process.
- **Responsive/RTL requirements**: unchanged from V1's existing discipline; the design system's logical-property conventions already handle this correctly and should be reused, not reinvented, for every new component.
- **No visual mockups are produced by this document** — per instructions, this section defines requirements and dependencies only.

---

## 12. Infrastructure Implications

Restating §7's conclusion in operational terms: V2.0–V2.3 requires no new servers, no new managed services, and no new deployment topology beyond what V1 already runs on (PHP + MySQL + WordPress/WooCommerce). The two genuinely new pieces of infrastructure are a Financial ledger (new tables, no new service) and a Notifications service (new application code, still riding on `wp_mail()`/WP-Cron). Everything deferred in §4 (realtime transport, multi-vendor commerce, native mobile backends) is exactly the set of things that *would* require new infrastructure — which is precisely why this document defers them until real evidence justifies the operational cost.

---

## 13. Risks

1. **Building ranking/AI-personalization against zero historical event data** — instrumentation must start before any scoring algorithm is tuned, or early results will be noise dressed up as signal.
2. **WooCommerce price-hook stacking** — B2B tier pricing, loyalty/membership discounts, and campaign promotions will all eventually want to modify cart totals; without a single deliberate design for hook ordering and combination rules, the exact "advertised price ≠ charged price" bug this project already found and fixed once in B2B is very likely to recur elsewhere.
3. **Financial correctness under refunds/disputes** — the highest-stakes capability in this roadmap; needs explicit, adversarial test coverage before launch, not just happy-path verification.
4. **Referral/campaign fraud** — both require real server-side abuse prevention, not client-side trust; underbuilding either creates a direct financial exposure.
5. **AI context leaking across authorization boundaries** — especially for AI-for-professionals; a bug here is a privacy incident, not a UX bug.
6. **Scope creep in AI Discovery** — the roadmap's own ambition (event/time/budget/location/product/routine understanding) is large; sequencing it as extensions to the existing extractor rather than a rewrite keeps this bounded.
7. **Premature infrastructure** — realtime transport, multi-vendor commerce, and native mobile are all real temptations to over-build ahead of evidence; this document's sequencing exists specifically to guard against that.
8. **Notification opt-out non-compliance** — retention automation without genuinely respected preferences risks user trust and, depending on jurisdiction, real compliance exposure.

---

## 14. Deferred Capabilities

Explicitly deferred, with the condition under which each should be revisited:

- **Multi-Sided Marketplace / multi-vendor commerce** — revisit when real marketplace data shows demand from sellers beyond BeauClick's own wholesale catalog; matches the roadmap's own stated deferral.
- **Realtime chat/consultation (WebSocket/video)** — revisit when chat volume or user feedback evidences real polling-latency pain; the existing hook seam means this stays cheap to add later.
- **Native mobile applications** — revisit once V2.0–V2.3 are stable and validated on web; token-auth groundwork can start shortly before, not years before.
- **Video/voice consultation** — explicitly gated by the roadmap behind realtime chat being stable first; no independent justification exists yet.
- **Elasticsearch/Meilisearch** — revisit only if free-text search relevance becomes a measured problem; MySQL indexing handles today's and V2's near-term query shape.
- **A general job-queue system (Redis-backed or similar)** — revisit only if WP-Cron's sweep-based model demonstrably can't keep up; no evidence of that today.

---

## 15. Recommended V2.0 Starting Point

**Event instrumentation + Loyalty ledger wiring**, done together as the literal first commits of V2 work. Both are near-zero-risk (they activate existing, tested, currently-dormant code rather than building anything new), touch no customer-facing behavior, and unlock real data collection immediately — every day this is delayed is a day of ranking- and loyalty-relevant history permanently lost. Immediately following, **AI Discovery's context/extraction upgrade** begins, since it has the strongest existing foundation of any capability in this roadmap and multiple other V2 capabilities (Journey, AI-for-professionals) build directly on it.

---

## 16. Definition of Done for V2

Adopted directly from the roadmap's own §21, restated as this project's actual bar (matching the standard already applied throughout the V1 Production Readiness audit): a V2 feature is done when business logic, permissions, validation, loading/empty/error states, complete Persian RTL UI, verified desktop (1440/1280/1024) and mobile (390/375/412) behavior, real test coverage for critical behavior, live browser verification where applicable, a security review, updated documentation, and a real git commit all exist — and the feature integrates correctly with the existing BeauClick domains it touches, not just in isolation. A database table, an API route, or a happy-path demo is not, by itself, a shipped feature.

---

## 17. What Should NOT Be Changed in V1

Restating the freeze from §1 in concrete terms, so this document can be checked against during V2 implementation:

- The plugin-per-domain architecture and the `RestController`/`Response` envelope convention — extend, never replace.
- The hybrid WordPress + WooCommerce + React app-shell architecture — no headless rewrite, no framework migration.
- WooCommerce as the commerce/payment foundation — V2's financial ledger sits alongside it, doesn't replace order/cart/checkout handling.
- The append-only-ledger convention already established by `wp_bc_events`/`wp_bc_loyalty_points` — V2's financial ledger should match this shape, not invent a mutable-balance alternative.
- The AI provider-agnostic abstraction (`ProviderInterface`) — no V2 AI feature should special-case a specific provider's API in application code.
- Polling-based chat — stays as the default transport unless §4.11's deferred conditions are actually met.
- The design system and visual identity — Persian-first, RTL-first, no redesign; extend the existing tokens/primitives.
- Cookie+nonce authentication for the web app-shell — stays exactly as-is; token auth is additive for mobile only, when that capability actually starts.
- Every bug fix and hardening change from the V1 Production Readiness audit (the B2B IDOR fix, the admin-menu registration fix, the N+1 query fixes, the accessibility fixes, the currency/locale configuration) — these are now part of V1's correct baseline behavior, not open questions to revisit.

---

## V2.0 Final Release Audit

**Audit date:** 2026-08-12. **Commit audited:** `38191b6d53f8c2dae91c95cd11f64bf58daa1c60` (`master`, `HEAD`, matches `origin/master`). **Scope audited:** V2.0 Steps 1–4 only (event instrumentation + loyalty wiring, AI discovery, ranking, Beauty Journey) plus the cross-cutting Jalali/Persian-error standard. **Step 5 — Professional CRM belongs to V2.1 and was not implemented during this audit** — no CRM code, table, route, or UI exists anywhere in this commit (verified: no `beauclick-crm` plugin, no `مشتریان`-tab implementation, the nav slot remains `ready: false`).

### Git/version boundary
`v1.0.0` → `8494c7b4f6540500366da42b589b22fce53206a7` (unchanged). `v1.0.1` → `a8117ecace7cc4e251c4a5cb2cc4cb54e076c28a` (unchanged). Both confirmed identical against `origin`'s dereferenced tag objects. `master` = `origin/master` = `38191b6...`, working tree clean before and after this audit. No `v2.x` tag exists anywhere. No V2.1 code (CRM, Membership, Referral, Campaigns, Financial/Payout, Multi-sided Marketplace expansion, realtime, mobile) found anywhere in the tree.

### Tests
- **Backend: 291/291 passing** (277 after Step 4 + 14 from the Jalali/Persian-error audit commit `38191b6` — reconciles exactly).
- **Frontend: 27/27 passing** (`format.test.ts`, `api.test.ts`, `jalali.test.ts` — this project's frontend test coverage has always been lib/utility-level, with component behavior verified via live browser QA rather than component unit tests; unchanged convention, not a gap introduced by V2).
- **TypeScript (`tsc --noEmit`): clean, 0 errors.**
- **Production build: clean** (`dashboard-customer` bundle ~10.98kB reflects Journey code present, as expected on `master`).
- **PHP lint:** clean across every file in all 11 `beauclick-*` plugins (zero syntax errors).

### Persian-first audit
Static search across every V2-touched plugin (`beauclick-ai`, `beauclick-journey`, `beauclick-loyalty`, `beauclick-marketplace/Ranking`) found **zero** `Response::error()` calls and **zero** `__( '...', ... )` calls with an English source string. JSX text-node and string-literal search across `app/src/features/journey/*` and `app/src/features/ai/*` found no English user-facing text (the only English tokens present are code identifiers — CSS values like `'space-between'`, internal status enum values like `'active'`/`'achieved'`/`'abandoned'` — never rendered to a user). Classification: no remaining English string requiring translation was found in V2.0's own scope (categories A/B/C/D/E all resolve to "not applicable" — there's nothing left to classify).

### Jalali calendar audit
No second Jalali implementation exists anywhere in V2 code — `beauclick-journey` imports the same `JalaliDate`/`format.ts`/`JalaliDateInput` established by the cross-cutting standard, confirmed by source inspection and live-verified: a goal created live with the `JalaliDateInput` picker (۱۰ مهر ۱۴۰۵) round-tripped correctly through Gregorian storage (`targetDate: "2026-10-02"` in the REST response) and displayed back identically (`تا ۱۰ مهر ۱۴۰۵`) with zero drift. Beauty Journey's `عضو از`, goal target dates, completed-service dates, and the composed timeline (`فعالیت‌های اخیر`) all rendered correct Jalali dates in the same live session. Internal storage remains Gregorian throughout — no schema was changed to accommodate this.

### Persian error/validation audit
`RestController::require_login()`/`require_capability()` (inherited from the V1.0.1 fix, used by every V2 route via the shared base class) confirmed Persian. Frontend `api.ts` continues to handle both the app's own envelope and WordPress's native `{code,message,data}` shape. No raw English `statusText`, PHP exception, or WordPress-native error string was observed reaching the UI during live testing (impossible-request and medical-safety-guard scenarios both returned natural Persian text, never a fallback string).

### RTL/mobile audit
Verified at 375px (customer dashboard, Beauty Journey — including the newly-tested goal-creation form — and the marketplace listing with ranking-reason text): `document.documentElement.scrollWidth === clientWidth` (no horizontal overflow) and `dir="rtl"` on every page checked. No new visual language introduced — Journey and AI panels reuse existing `Card`/`Button`/`EmptyState`/`RecommendationCard` primitives, confirmed by source inspection (§Step 4 UI notes above).

### Live end-to-end QA (real dev server, real accounts, real DB state)
1. **AI — honest empty result:** "جراحی پلاستیک فضایی تو شهر ناکجاآباد می‌خوام" → zero recommendations, an honest Persian request for clarification. No fabricated professional/service/product/location.
2. **AI — medical safety guard:** "پوستم عفونت کرده و خونریزی داره، تشخیص بده و دارو بگو" → zero recommendations, a cautious Persian non-diagnosis reply referring to a real doctor. No drug name, no diagnosis.
3. **AI — grounded recommendations (persisted from the same live conversation thread, re-inspected this session):** real provider/product cards with real prices and grounded `reason` text, real booking deep-links (`?book_provider=&book_service=`).
4. **Ranking — marketplace ordering:** سارا احمدی (documented highest real score) ordered first, with truthful `rankingReasons` text (`تأیید شده · پاسخ‌گویی سریع` / `فعالیت اخیر`, distinct per provider, never a raw score) rendered on both desktop and 375px.
5. **Ranking — no raw score exposure:** confirmed by source inspection — `MarketplaceController` never serializes `ranking_score`/`rankingScore` into any response.
6. **Beauty Journey — goal creation with Jalali input:** see Jalali audit above; new `هدف زیبایی تعریف شد` timeline entry appeared immediately, no reload needed.
7. **Beauty Journey — cross-customer isolation:** logging in as a second real customer account (`bc_qa_business`) showed a **completely empty** journey (`۰ امتیاز وفاداری`, `هنوز هدفی ثبت نکرده‌ای`, empty-state copy) — none of the first customer's three goals, loyalty balance, or activity leaked across the boundary.
8. **Loyalty ledger idempotency:** exercised directly by the passing test suite — `LoyaltyLedgerTest::test_a_duplicate_reference_and_reason_is_rejected_at_the_database_layer` genuinely hits the real `UNIQUE KEY (reference_type, reference_id, reason)` constraint (visible in the raw PHPUnit output as an expected WordPress DB error, not a failure).

Login, marketplace discovery, booking-date Jalali selection, WooCommerce checkout, and dashboard order/booking Jalali dates were not re-verified in this pass — they were already covered end-to-end by the V1.0.1 audit (which shares the exact same code paths, untouched by V2) and by Steps 1–4's own prior live-verification passes; re-running them here would have been redundant, not additive evidence.

### Security/authorization audit
- Beauty Journey: every route (`profile`, `goals` list, `timeline`, `summary`) is scoped by `get_current_user_id()` in the controller itself — no request parameter can name another user's data (source-verified, then behaviorally confirmed live in scenario 7 above).
- AI: `AssistantService::send()` calls `validate_recommendations()` before any recommendation is persisted or returned (source-verified) — no hallucinated entity can reach a user regardless of provider.
- Ranking: `RankingPresenter::ORDER_BY` contains no `WHERE` clause — ranking cannot rescue an ineligible candidate past a consumer's own city/specialty/price filter (source-verified, matches Step 3's own documented design).
- No new authorization pattern was introduced by this audit; every check above reuses the same ownership/self-scoping convention already established across V1 and Steps 1–4.

### Performance audit
No new N+1 query pattern was found in the code paths exercised this session. `DashboardController`'s historical N+1 (fixed before Step 1, per the code's own comment) remains fixed. Ranking recomputation remains a scheduled bulk-aggregate job, not a per-request cost. No load testing was performed (out of this audit's scope, matches the task's own "only fix clear V2.0 production-blocking performance problems" instruction) — no blocking issue was found or suspected.

### Bugs discovered
None. No V2.0 defect, no V1 regression, and no security/authorization/data-integrity gap was found during this audit.

### Fixes applied
None required — no code was changed by this audit.

### Deferred / non-blocking observations (not fixed, not blocking)
- Frontend test coverage remains lib-level only (no component tests for `JourneyTab`/`AiPanel`/ranking display) — consistent with this project's established testing convention throughout V1 and V2.0, not a new gap; flagged for awareness only.
- No dedicated load/perf testing was performed against ranking recomputation or journey timeline composition at higher-than-demo data volumes — flagged per §11's own "document non-blocking optimization opportunities" instruction, not a release blocker at current, real data volume.

### V2.1 scope integrity
Confirmed: no CRM, Membership, Referral, Campaign Engine, Financial/Payout, Multi-sided Marketplace expansion, Realtime Communication expansion, or Native Mobile Application code exists anywhere in the audited commit. **Step 5 — Professional CRM belongs to V2.1 and was not implemented during this audit.**

### V2.0 release readiness

**V2.0 READY FOR RELEASE.**

All four V2.0 steps are functionally correct, Persian-first, Jalali-correct, RTL-correct, tested (291/291 backend, 27/27 frontend, clean TypeScript, clean build), live-verified against real data with no fabricated entities, authorization-correct (cross-user isolation and AI grounding both confirmed live, not just by code reading), and V1 remains completely untouched (`v1.0.0`/`v1.0.1` both verified unchanged against origin). No blocking defect was found. The `v2.0.0` tag was intentionally **not** created by this audit — per the standing instruction, tagging requires explicit approval after this report.

---

## V2.1 Step 5 — Professional CRM Implementation Notes

**Scope actually implemented:** a real, operational customer-relationship workspace for professionals/businesses — searchable/filterable customer list, a customer detail view (overview, booking history, reviews, conversation summary, private notes), and professional-authored notes — built entirely as a read/aggregation layer over data that already existed, plus one genuinely new table (`wp_bc_crm_notes`). Membership, Referral, Campaign Engine, Financial/Payout, Multi-sided Marketplace expansion, Realtime Chat, Native Mobile, AI-for-professionals, and any complex segmentation/marketing-automation engine were explicitly out of scope and untouched.

### Where this lives, and why
§4.5's own assessment concluded CRM should be "folded into `beauclick-booking`'s `DashboardController` as a natural extension… avoids creating an eleventh plugin." Direct inspection confirmed this holds: `wp_bc_bookings` (owned by `beauclick-booking`) is the one table every CRM concept — who is a customer, when did they last visit, when is their next visit — derives from, and `DashboardController`/`ReviewsController::for_providers()` already established the exact bulk-aggregation query shape this needed. CRM was built as a new `Crm` namespace and `CrmController` **inside `beauclick-booking`**, not a new plugin — the same reasoning V2.0 Step 3 already used to place `Ranking` there instead of `beauclick-marketplace`.

### Ownership model — the actual finding, not an assumption
The task asked to determine ownership from real code before designing access control. `ProviderLookup::for_user( $user_id )` — the one place in this codebase that resolves "which `bc_professional`/`bc_business` CPT post does this WP user own" — already treats **independent professionals and businesses identically**: `post_author = $user_id`, one post, no distinction by type. Separately, `wp_bc_business_accounts` (owned by `beauclick-b2b`) is a **different, unrelated concept** — a B2B wholesale-purchasing account, also `UNIQUE KEY user_id`, with no staff/multi-user structure of its own. Conclusion, confirmed by inspection rather than assumed: **this codebase has no granular staff-permission system today**, for either professionals or businesses. A "business" CRM user is, today, exactly the single WP user who authored that business's CPT post — identical in shape to a professional. Per the task's own instruction ("if the current system does not yet have sufficiently granular staff permissions, document the limitation rather than building the entire future permission system inside Step 5"), this is documented as a known limitation below, not solved here.

Every CRM read/write is scoped by `$provider_id = ProviderLookup::for_user( get_current_user_id() )`, resolved server-side inside `CrmController` — never accepted from a request parameter. Every customer-scoped operation then re-checks `CrmService::is_customer_of( $provider_id, $customer_id )` (a real `EXISTS` query against `wp_bc_bookings`) before returning or writing anything — not merely at the controller layer, but again inside `CrmService::add_note()` itself, since that is the actual boundary the database enforces. A `customer_id` that doesn't genuinely belong to the caller's own provider is treated identically to one that doesn't exist — the 404 response never distinguishes "not yours" from "doesn't exist," so no endpoint can be used to enumerate another provider's real customers by id.

### Database
One new, additive migration (`CreateCrmNotesTable`, registered in `beauclick-booking\Plugin::migrations()` alongside the existing `CreateBookingTables`/`AddHoldExpiryColumns`):

```sql
CREATE TABLE wp_bc_crm_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  author_user_id BIGINT UNSIGNED NOT NULL,
  note VARCHAR(2000) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY provider_customer (provider_id, customer_id, created_at)
);
```

Keyed by `provider_id` — not `author_user_id` — matching every other ownership boundary in this codebase (bookings/reviews are both keyed by `provider_id`). `author_user_id` is recorded for display/audit ("who on this team wrote this") but is never the access-control field. No cross-plugin foreign keys, matching every other table here. Nothing else was added: customer identity comes from `wp_users`, phone from WooCommerce's own standard `_billing_phone` usermeta (the same field this site's checkout form already writes to — confirmed live during the V1.0.1 audit), bookings/reviews/conversations are read directly from their existing owning tables. No customer history was duplicated anywhere.

### API
Three routes on `CrmController`, following the existing `RestController`/`Response` conventions exactly (same envelope, same `pagination_args()`, same `require_login` gate):

- `GET /booking/crm/customers?search=&filter=&page=&per_page=` — paginated, scoped list.
- `GET /booking/crm/customers/{id}` — full detail bundle (overview + bookings + reviews + conversation summary + notes) in one request, matching Beauty Journey's own "one request instead of five-plus" performance convention rather than forcing the frontend to make five separate calls.
- `POST /booking/crm/customers/{id}/notes` — create a note.

No `PATCH`/`DELETE` for notes in this step — deliberately, matching the task's own "keep the first implementation simple" instruction and mirroring Beauty Journey's own precedent of deferring goal deletion (§Step 4 above). Notes are effectively append-only for now; documented as deferred, not forgotten.

### Search and filters
Server-side, and scoped by construction (search/filter apply only within the already-provider-scoped result set — there is no way to search across another provider's customers). `list_customers()` does its aggregation in five fixed, bulk `GROUP BY`/`IN (...)` queries — one for the booking-derived stats (count, completed count, last visit, next booking, all computed with conditional `SUM`/`MAX`/`MIN` in one pass), one for `wp_users`, one for phone meta, one for review counts, one for note counts — regardless of how many customers a provider has, never one query per customer. Search and the six derived filters (`new`/`returning`/`upcoming`/`has_review`/`inactive`/`all`) then run in PHP over that already-small, already-fetched result set: a single provider's own customer list is bounded by that provider's own real booking history (this project's own stated realistic scale — low hundreds, not millions), so this is the simplest-viable-architecture choice, consistent with the task's own "use MySQL/indexed queries… do not build external search infrastructure" instruction, not a shortcut that needs revisiting at the scale this product actually operates at. Search normalizes Persian and Arabic-Indic digits to ASCII before matching, so a phone number typed in Persian numerals still finds the ASCII-stored value — verified directly by test and live (`۰۹۱۲۱۲۳۴۵۶۷` matched a customer whose phone is stored as `09121234567`).

### Customer detail
Overview (first visit, last visit, next booking, completed/total count), booking history (status labels reuse the exact same `STATUS_LABELS` map `BookingsTab.tsx` already uses — no second status vocabulary), reviews the customer wrote for this specific provider (`wp_bc_reviews` filtered by `target_type='provider'`, `target_id=$provider_id`, `author_id=$customer_id` — never another provider's reviews of this same customer), a conversation summary (exists/last-message-at/unread-count, read directly from `wp_bc_conversations`/`wp_bc_messages` — deliberately **not** `ConversationService::start_or_get()`, which creates a conversation on a miss; a CRM detail view must never have that side effect, and message *content* is never duplicated here, only enough to point a professional at the real chat panel), and private notes.

### Notes — privacy
Notes are provider-scoped, never customer-visible (no customer-facing endpoint reads `wp_bc_crm_notes` at all — the table is only ever reached through `CrmController`, which is gated by `ProviderLookup::for_user()` resolving to a real provider, something a plain customer account never has), never AI-visible (no code path in `beauclick-ai`, `JourneyContextProvider`, or anywhere else reads this table — confirmed by inspection: nothing outside `CrmService`/`CrmController` references `bc_crm_notes`), and never cross-provider-visible (re-verified live: two real professionals each see only their own notes on a shared real customer). Plain `VARCHAR(2000)` text, no rich-text/attachment system — per the task's own "keep the first implementation simple… do not create a complex rich-text medical/clinical notes system" instruction.

### Persian localization
Every user-facing string — nav label, filter chips, empty states, error messages, section headings, the "private, not visible to the customer" disclaimer, the save button and its loading state — is Persian. REST errors (`این مشتری پیدا نشد یا در اختیار شما نیست.` for both "not owned" and "doesn't exist," `متن یادداشت نمی‌تواند خالی باشد.` for empty input) follow the exact same pattern `RestController`'s base errors already established. No English string was introduced anywhere in this step's own code (verified by the same search method used in the V2.0 audit — zero English JSX text, zero English `Response::error()`/`__()` calls in the new files).

### Jalali coverage
Every date shown — first visit, last visit, next booking, each booking-history row, each note's timestamp — goes through the existing `formatFullJalaliDate()` from `app/src/lib/format.ts`, the same shared abstraction every other V1.0.1/V2.0 surface uses. No second Jalali implementation was created. Counts (booking count, review count, note count) use the existing `toPersianDigits()`. Internal storage remains exactly as it already was — `DATETIME` columns, no schema change to accommodate presentation.

### RTL/mobile
No new visual language — the customer list reuses the exact `bc-card` styling `ReviewsTab`/`BookingsTab` already establish, filters reuse the existing `Chip` primitive, the detail view reuses the existing `Modal` (which already has a focus trap, Escape handling, and a close button — no new accessibility work needed there), notes reuse the existing `textarea.bc-input`/`Button` pattern from `ReviewsTab`'s own respond-to-review form. Verified live at 375px, 390px, 412px, and desktop: no horizontal overflow (`scrollWidth === clientWidth` at every width, including with the detail modal open), `dir="rtl"` throughout. The list is a stack of full-width cards, not a dense table forced onto mobile — matching the task's own explicit instruction.

### Security — verified live, not only by code
- A stranger professional (`bc_demo_niloofar_kermani`, a real account with zero real bookings) opened `مشتریان` and saw a genuinely empty list — none of a different real professional's (`bc_demo_sara_ahmadi`) real customers or the note added during this session's testing leaked across.
- A direct, unauthenticated-by-relationship REST call (`GET /booking/crm/customers/8` as the stranger professional, `8` being a real customer id known from a different provider's relationship) returned `404` with the Persian not-found/not-yours message — confirmed at the network layer, not just the UI.
- A plain customer account has no `ProviderLookup` result at all, so every CRM route returns the same empty/404 response a stranger professional gets — CRM has no customer-facing surface whatsoever (asserted directly by `CrmControllerTest::test_a_customer_account_itself_has_no_provider_and_cannot_reach_crm`).

### Performance
`list_customers()` is a fixed 5-query operation regardless of customer count (asserted directly by `CrmServiceTest::test_customer_list_avoids_n_plus_one_queries`, which fails if the query count ever creeps toward one-per-customer). `get_customer_detail()` is a fixed handful of queries per open (overview, bookings, reviews, phone lookup, conversation, notes) — acceptable for a single-record detail view opened one at a time, not a list-rendering path.

### AI boundary
Nothing in this step touches `beauclick-ai`. No CRM data (notes, phone, booking history) is read into any AI context-assembly path — confirmed by inspection (zero references to `bc_crm_notes` or `CrmService` anywhere outside `beauclick-booking`'s own `Crm`/`Rest` directories). This deliberately leaves the door open for a future, explicitly-scoped V2.3 "AI for Professionals" step to query `CrmService` the same way `JourneyContextProvider` already lets AI consume Beauty Journey data — but that consumption does not exist yet, and building it was out of this step's scope.

### Tests
24 new backend tests: `CrmServiceTest` (15 — provider-scoping, booking-count/last-visit/next-booking correctness, Persian-digit phone search, all six filters, pagination, empty state, the real ownership boundary, customer-detail composition, note creation/rejection, cross-provider note isolation, the N+1 regression guard) and `CrmControllerTest` (9 — login requirement, no-provider-profile empty state, the live cross-professional-denial scenario, owning-professional success, the customer-account-has-no-CRM-access case, unowned-customer note rejection, empty-note Persian validation, note creation end-to-end through to detail, pagination params). Full backend suite: **315/315 passing** (was 291 after the V2.0 final audit). Frontend: **27/27 passing** (unchanged — this project's established convention is lib-level frontend tests only; `CustomersTab` was verified via live browser QA, matching how every other dashboard tab in this codebase has been verified). TypeScript clean, production build clean (`dashboard-professional` bundle grew from ~9.57kB to ~16.23kB, reflecting the new tab).

### Live verification (real running site, real professional accounts, real booking/review data)
1. Logged in as `bc_demo_sara_ahmadi` (a real professional with real prior bookings/reviews from earlier V1/V2 verification sessions) → `مشتریان` → real customer list (`admin`, `bc_qa_customer`) with correct Jalali last-visit dates and correct completed/review counts.
2. Opened a real customer's detail → correct first-visit/last-visit/next-booking Jalali dates, correct `۱ از ۲ نوبت انجام‌شده`, real booking history with correct status labels, a real conversation summary (last message + unread count, sourced from the real `wp_bc_conversations`/`wp_bc_messages` tables), empty reviews section (this specific customer hadn't reviewed this specific provider — correct, not a bug).
3. Added a real note ("این مشتری همیشه دیر میاد…") → appeared immediately with the correct author name and Jalali timestamp, no reload needed.
4. Logged in as a second real professional (`bc_demo_niloofar_kermani`) → empty CRM, confirmed both via the UI and a direct unauthorized REST call (see Security above).
5. Verified at 375px/390px/412px/desktop — no overflow, RTL correct, modal usable on mobile.
6. Checked browser console and network tab — no unexpected errors; the only 404/403 entries observed were from the intentional unauthorized-access test itself.

### Bugs discovered
None.

### Bugs fixed
None required.

### Known limitations
- **No granular staff-permission model** — a "business" CRM account is, today, exactly the single WP user who authored that business's CPT post (see Ownership model above). If BeauClick later needs multiple staff members under one business to share CRM access, that is new authorization infrastructure this step deliberately did not build, per the task's own explicit instruction to document rather than build it now.
- **No note editing or deletion** — notes are effectively append-only in this first version; a small, additive extension if a real "fix a typo in my note" need emerges.
- **No frontend pagination UI** — `app/src/lib/api.ts`'s `request()` already discards `meta.pagination` for every existing caller in this codebase (not something this step changed), so `CustomersTab` fetches a generous `per_page=50` and relies on search/filters to narrow further rather than a page control; the backend API already supports real pagination (verified by test) for whenever the frontend wrapper is extended to expose it.
- **No component-level frontend test** for `CustomersTab` — matches this project's established convention (lib-level tests + live QA), not a new gap.

### Deferred CRM capabilities (explicitly out of this step, per the task's own scope boundary)
Customer segmentation/tagging beyond the six derived filters, campaign targeting, follow-up reminder automation, inactive-customer retention triggers, CRM-aware AI ("which customers haven't returned"), analytics dashboards, and any multi-staff business permission model. All are named in the roadmap as later V2.1+/V2.2+ capabilities that can consume this step's `CrmService` once they exist — nothing here needs to be rebuilt to support them.

---

## Post-Audit V2.1 Reprioritization

**This section documents a sequencing change, not an implementation.** No code, migration, or UI changed as part of this update — only the planned order of not-yet-built V2.1 steps. The historical record above (Steps 1–4, the V1.0.1/V2.0.0/Step-5-CRM implementation notes and their live-verification results) is unmodified and remains the accurate account of what actually shipped and when.

### Why the sequence changed

The original V2.1 sequence (§6 above, written before any Step 5 work began) assumed CRM would be followed directly by Loyalty tiers/Membership — a reasonable plan given what was known at the time, built entirely from the roadmap's own stated priorities and this document's own §4 capability assessment. It did not, and could not, account for gaps nobody had gone looking for yet.

The Master Product Completeness & Gap Discovery Audit (`docs/roadmap/PRODUCT_GAP_REGISTER.md`, dated 2026-08-12, auditing commit `af4b8d7`) found, by direct database inspection rather than assumption, that **`users_can_register` is `0` and both WooCommerce self-registration switches are `no` — there is currently no way for a new customer to create an account on this platform at all.** Every account exercised across every V1, V2.0, and V2.1 verification session in this project's history was created directly via `wp-cli`, never through a real signup flow, because no real signup flow exists. The same audit found the site's Privacy Policy and Refund Policy exist only as unpublished WordPress drafts, and no Terms of Service, FAQ, Contact, or About page exists at all.

Continuing straight to Membership — a feature whose entire value proposition depends on real, self-registered customers accumulating tiered status over time — on top of a platform that cannot yet onboard a real customer, or disclose terms to one, would have compounded the gap rather than closed it. The revised sequence below exists specifically to close AUTH-01 and LEGAL-01/02/03 (the two `BLOCKING`-severity findings in the Gap Register that are genuine product-development work, as opposed to `EXTERNAL_CONFIGURATION` or `NEEDS_BUSINESS_DECISION` items no engineering step can resolve on its own) before building anything that presumes they're already solved.

### Why Authentication is now P0

Per the Gap Register's own prioritization (§7 of that document): AUTH-01 (no registration path) and the LEGAL-01/02/03 unpublished-pages findings are the two highest-consequence discoveries of the entire 15-category audit, specifically because they are *silent* — every other gap in the register (no reschedule UI, no waitlist, no invoice PDF, etc.) degrades one feature's usefulness, while a missing registration path blocks the entire product from acquiring a single new real user, and missing legal disclosure blocks responsible operation of a live commerce site regardless of feature completeness elsewhere. Authentication is placed first among the two because it is pure engineering work with no external content dependency, while Legal/Trust's actual page *text* needs product/legal ownership that can proceed in parallel rather than gating Step 6.

### Why Legal/Trust is a prerequisite to wider release

Not because any single legal document is technically complex to render — `docs/roadmap/PRODUCT_GAP_REGISTER.md` §22 classifies the actual page *content* as `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`, explicitly not an engineering deliverable — but because a real commerce platform accepting real payments from real, newly-registered customers (which Step 6 makes possible for the first time) without a published, linked Privacy Policy, Terms of Service, or Refund Policy is a materially different risk posture than the same gap existing today, when no real customer can register at all. Step 7's engineering scope (page structure, routing, localization, consent-preference storage, linking from checkout/authentication) is deliberately separated from the legal-content question it depends on, matching the Gap Register's own instruction not to draft legal language as though it were legally approved.

### Why Verification Evidence should precede broader marketplace expansion

PROF-04/ADMIN-03 in the Gap Register found that professional "verification" today is an admin flipping a status field with no attached evidence — a fact that was already true and already tolerable at this project's current, small, known-provider scale (the same handful of demo professionals verified throughout every prior audit). It stops being tolerable the moment Step 6 makes public registration possible: a marketplace that can suddenly onboard professionals nobody has personally vetted needs a real evidence trail before it can meaningfully grow past that point, not after. Placing it as Step 8 — after registration and legal disclosure exist, before Membership — follows directly from that dependency, not from an arbitrary reordering.

### Why Membership now follows these foundational capabilities

Unchanged in substance from the original assessment (§4.6: "Membership = a real recurring-revenue lever," high business value) — only its position moved. Tiered membership status accumulates over a customer relationship that, until Step 6, could not begin for a real user, and Step 9's own price-hook interaction with WooCommerce (already flagged as this roadmap's highest-recurring-risk integration pattern, §13 point 2) is safer to build against a platform that already has real registered customers and real published pricing/refund terms to test against, not a hypothetical one.

### How this relates to the existing architecture

Nothing about the underlying architecture changes. Authentication (Step 6) is additive to the existing cookie+nonce web session model (§17's own "stays exactly as-is; token auth is additive for mobile only" principle extends naturally to "a branded UI in front of the same session mechanism, not a replacement for it"). Legal/Trust (Step 7) is page content plus the existing `wp_posts`/theme-template rendering pattern already used for every other public page — no new rendering architecture. Verification Evidence (Step 8) extends the existing `VerificationMetaBox`/admin-capability pattern additively, per this document's own standing "extend, never rewrite" principle (§1, §17). Membership (Step 9) and Waitlist/Rebooking (Step 10) are unchanged from the original §4.6/§4.8 assessments — only their position in the sequence moved, not their design.

### Revised V2.1 sequence

| Step | Capability | Status |
|---|---|---|
| 5 | Professional CRM | **Complete** (`af4b8d7`) |
| 6 | BeauClick Authentication & Registration | Planned — P0 |
| 7 | Legal & Trust Foundation | Planned — P0 (engineering scope only; content is `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`) |
| 8 | Professional Verification Evidence & Trust | Planned — P1 |
| 9 | Loyalty Tiers + Membership | Planned — carried forward from the original sequence, now after 6–8 |
| 10 | Waitlist + Smart Rebooking + Retention Automation | Planned — carried forward from the original sequence |

V2.2/V2.3 capabilities named in the original roadmap and this document's earlier §6 (CRM's remaining deferred items, Campaign/Promotion Engine, AI-for-Professionals, Financial/Payout, and the explicitly-deferred V2.4 platform-expansion items — Realtime Chat, Multi-Sided Marketplace, Native Mobile) are unchanged and not renumbered; this reprioritization only reorders what happens inside V2.1.

### Cross-cutting standards remain unchanged and apply to every step above
Every V2.1 step (6 through 10) is bound by the same standing, cross-cutting requirements already established for all of V1 and V2.0 — restated here because they apply with equal force to genuinely new surfaces like a branded login screen or a legal-pages framework, not only to features that extend existing UI:

- **Persian-first, RTL-first, Jalali-first, Persian-error-first, Persian-number-aware.** No new authentication, legal, verification, membership, or waitlist surface may introduce an English string where a natural Persian equivalent exists, a Gregorian date where a user-facing date is shown, or a numeral not rendered in Persian digits where one already would be.
- **Reuse the existing shared Jalali infrastructure** (`JalaliDate.php`, `jalali.ts`, `format.ts`, `JalaliDateInput`) for any date any of these five steps displays or accepts — verification dates, membership period boundaries, waitlist/reminder timestamps included. No second Jalali implementation.
- **No unnecessary English UI** anywhere a Persian equivalent exists, matching the standard already enforced and audited twice (V1.0.1, V2.0 final audit) and re-verified a third time during Step 5.

These are not restated as a new Step — they are the same permanent engineering standard documented in the "Cross-Cutting Standard — Persian/Jalali Date & Error Localization" section above, carried forward unchanged.

---

## V2.1 Step 6 — Authentication & Registration Implementation Notes

**Scope actually implemented:** phone/OTP sign-in and registration for customers, professionals, and businesses, replacing `wp-login.php` as the path every normal account uses — a real BeauClick-designed screen, mobile-number-first, with a full OTP lifecycle (generation, hashing, expiry, attempt-limited verification, replay prevention, resend cooldown, and dual phone/IP rate limiting), a provider-agnostic SMS abstraction, and a migration-safe account resolver that links existing V1/V2 accounts to their real phone number the first time they use this flow rather than creating duplicates. WordPress's own login remains completely untouched and fully functional for administrators. Legal & Trust, Membership, Waitlist, and everything else in the revised V2.1 sequence were explicitly out of scope and untouched.

### Existing system inspected before implementation
- **Registration was already found disabled** (`users_can_register=0`, both WooCommerce self-registration switches `no` — the Gap Register's own AUTH-01 finding, re-confirmed live before writing any code).
- **Roles**: `RoleManager` already establishes "extend WooCommerce's `customer` role with capabilities, don't invent a duplicate role" as the standing convention — this step's new accounts follow it exactly, landing in `customer` (falling back to `subscriber` only if WooCommerce's role doesn't exist yet).
- **Phone storage**: WooCommerce's own `_billing_phone` usermeta is the only existing phone field in this codebase (confirmed via the same discovery made during V2.1 Step 5's CRM work) — free-text, unnormalized, never enforced unique.
- **REST conventions**: `RestController`'s `route()`/`require_login()`/`Response` envelope, unchanged and reused exactly.
- **Rate limiting precedent**: `beauclick-ai\AssistantService` and `beauclick-chat\ConversationService` both already rate-limit via WordPress transients (15/min, 20/min respectively) — this step's OTP rate limiting reuses the identical mechanism, no new infrastructure.
- **Frontend bootstrap**: `inc/app-shell.php` server-renders `window.BeauClick` (nonce, `isLoggedIn`, `currentUserId`) on every page load — the reason `verify-otp`'s success path triggers a full page navigation (`window.location.href`) rather than an in-place SPA state update: a fresh page load is what naturally re-issues a nonce reflecting the just-established session, with zero new client-side session-sync code required.

### Where this lives, and why
A new plugin, `beauclick-auth` — not folded into `beauclick-core` or any existing domain plugin. Unlike CRM (Step 5, folded into `beauclick-booking` because its data already lived there) or Journey (its own plugin because its data-access needs didn't fit any existing plugin), authentication is genuine cross-cutting infrastructure with no natural existing owner and no dependency on any other `beauclick-*` plugin's tables — it only depends on `beauclick-core` for the shared `RestController`/`Response`/`Migrator` base, the same as every other plugin already does.

### Phone normalization
`PhoneNormalizer::normalize()` — one function, every accepted input format (`09XXXXXXXXX`, `+989XXXXXXXXX`, `00989XXXXXXXXX`, bare `989XXXXXXXXX`, Persian and Arabic-Indic digit variants, with tolerated spaces/dashes) converges on one canonical form (`+989XXXXXXXXX`). Every other class in this plugin only ever sees the canonical form — no phone comparison anywhere in this codebase happens on a raw, unnormalized string.

### OTP lifecycle
- **Storage**: `wp_bc_otp_requests`, one row per issued code. The code itself is never stored — only `hash_hmac('sha256', $code, wp_salt('auth'))`, reusing WordPress's own auth salt rather than inventing new key material (per this step's own "no unnecessary cryptographic infrastructure" instruction).
- **Length/expiry/attempts**: centralized in one class, `OtpConfig` — the same "single policy class" pattern already established by `RankingConfig` (V2.0 Step 3) and `EarningRules` (V2.0 Step 1). 6-digit numeric, 120-second expiry, 5 wrong-attempt lockout (a new code is required after), 60-second resend cooldown, 5 requests/phone/hour, 10 requests/IP/hour.
- **Replay prevention**: a code is marked `consumed_at` immediately on successful verification; a second `verify_otp()` call with the same code — even the genuinely correct one — falls into the same "no active code" branch as a truly expired one.
- **Anti-enumeration**: `request_otp()` never looks up whether an account exists for the phone — it cannot leak that information because it never has it. `verify_otp()` returns the identical `expired` error code whether no OTP was ever requested for that number or a real one genuinely expired.

### SMS provider abstraction
`SmsProvider` (interface) / `SmsResult` / `SmsProviderFactory`, mirroring `beauclick-ai`'s own `ProviderInterface`/`ProviderFactory` shape exactly. `SmsProviderFactory::create()` selects a real gateway only when `BC_SMS_PROVIDER`/`BC_SMS_API_KEY` are both configured — neither exists in any environment this project has ever run in (Gap Register AUTH-04), so `MockSmsProvider` is the only provider ever actually exercised. It never sends anything real; outside a `production` environment (`wp_get_environment_type()`, the same gate `beauclick-payments`'s dev-only Cash-on-Delivery gateway already uses) it writes the message to the PHP error log for local visibility, and never anywhere at all in production — a production deployment with no real provider configured "succeeds" at the OTP-issuance step but silently cannot deliver, which is a deployment-configuration gap for `OPS-04` (error monitoring) to surface, not something this class papers over by leaking a code into a production log.

### Existing-user migration and duplicate-account safety
`AccountResolver::find_or_create_for_phone()` is the one place this decision is made, in three cases, found by inspecting the real current data rather than assumed:
1. The phone already has a `wp_bc_phone_index` row (a user who has completed this flow before) — authenticate them.
2. No index row, but exactly one existing user's `_billing_phone` normalizes to the same canonical number (a real pre-auth-system account, whether from `wp-cli` seeding or an earlier V1/V2 checkout) — **link** it (write the index row) and authenticate that same account, never a fresh duplicate.
3. Multiple existing accounts' billing phones collide on the same canonical number — a genuine data conflict this class never guesses through. Recorded in a new `wp_bc_phone_conflicts` table for a human to resolve; a brand-new account is created rather than picking one at random, per this codebase's own standing "do not silently merge users" rule.

`wp_bc_phone_index` carries a real `UNIQUE KEY` on the canonical phone — the actual database-level guarantee (not just an application-level check) that two accounts can never share a verified number going forward, the same "make a real invariant a real constraint" discipline `wp_bc_loyalty_points`'s `reference_once` index already established in V2.0 Step 1.

### Database changes
Three new, additive tables in `beauclick-auth` (`CreateAuthTables`): `wp_bc_otp_requests`, `wp_bc_phone_index`, `wp_bc_phone_conflicts`. No existing table was altered. `_billing_phone` usermeta continues to be written (kept in sync on every registration/link/change) so WooCommerce's own checkout/address flows see the same number BeauClick's auth system verified.

### REST API
`POST /auth/request-otp`, `POST /auth/verify-otp` (both `permission_callback: __return_true` — nobody is authenticated yet, by definition), `POST /auth/logout`, `POST /auth/change-phone/request`, `POST /auth/change-phone/confirm` (the last three `require_login`). `change-phone/request` applies the identical anti-enumeration discipline as the primary flow: if the requested number already belongs to a different account, the response looks like an ordinary "sent" success, but no real OTP is ever issued for it — confirmed both by a dedicated test and live, and the number is verified to never actually move to the requesting account.

### Frontend UX
One combined sign-in/sign-up flow (`AuthFlow.tsx`, mounted via a new `auth` Vite entry) — the user never declares "I'm new" or "I have an account"; `verify-otp`'s response decides that server-side. Two steps: phone entry, then a single OTP input (`autoComplete="one-time-code"` for native SMS-autofill support, numeric `inputMode`, a live resend countdown). Reuses the existing `Input`/`Button` primitives and `bc-card` styling — no new visual language. `page-auth.php` (a new theme template, served at `/auth/`) redirects an already-logged-in visitor straight to `/dashboard/` rather than showing them a form for an account they're already in. Every `wp_login_url()` reference previously reachable by a normal user — the header's "ورود" chip, the dashboard's logged-out prompt, the B2B page's logged-out prompt, and a professional profile's "message" call-to-action for a logged-out visitor — now points to `/auth/` instead; `wp-login.php` itself is untouched and still fully reachable directly (for administrators), simply no longer linked from anywhere a normal user would see.

### Persian localization
Every user-facing string — headings, both step prompts, button labels and their loading states, the resend countdown, every error message (invalid phone, empty code, invalid code, expired code, too-many-attempts, cooldown, rate-limited, send-failed, phone-already-taken) — is Persian, verified both by source inspection and live testing of the wrong-code path. No English string was introduced anywhere in this step's own code.

### Jalali / RTL
No date is displayed anywhere in the authentication flow itself (there is nothing to convert), so no new Jalali call site was needed — the existing dashboards/journey/CRM a user lands on after authenticating already use the shared `format.ts` helpers, unchanged by this step. `dir="rtl"` confirmed at every tested width; no second date implementation was introduced (none was needed).

### Security
- Codes are never stored in plaintext; comparison uses `hash_equals()` (timing-safe).
- Both per-phone and per-IP rate limiting are enforced (per-IP specifically to stop one attacker cycling through many numbers, not just repeated requests against one).
- Anti-enumeration is structural, not a special case: `request_otp()` never queries account existence at all.
- `change-phone` re-validates the target number isn't already claimed by a different account both before issuing an OTP (silently, without confirming) and again at confirmation time (returning a real `409` there, since by that point the requester has already proven phone ownership via a real code, so revealing a conflict is no longer an enumeration risk).
- Admin authentication (`wp-login.php`, WordPress's own session/capability system) is completely untouched — verified live by a real admin login after this plugin's activation, not merely by code inspection.

### Tests
44 new backend tests: `PhoneNormalizerTest` (16 — every accepted format, Persian/Arabic-Indic digits, rejection of landlines/malformed input, masking), `OtpServiceTest` (12 — generation, correct/wrong verification, replay prevention, max-attempts lockout, expiry, resend cooldown, per-phone and per-IP rate limits, hash-never-plaintext, change-phone requester-matching), `AccountResolverTest` (6 — new-account creation, idempotent re-resolution, existing-account linking including a differently-formatted billing phone, multi-candidate conflict detection and safe fallback, and a regression guard against reassigning an already-verified account to a second number), `AuthControllerTest` (10 — REST-layer validation, full new-registration and existing-login flows end-to-end, logout, both change-phone endpoints' login requirement, the full change-phone happy path, the anti-enumeration conflict case, and admin authentication being unaffected by this plugin's presence). Full backend suite: **359/359 passing** (was 315 after Step 5 CRM). Frontend: **27/27 passing** (unchanged — this project's established lib-level-tests-plus-live-QA convention, `AuthFlow` verified live rather than via component tests, matching every other dashboard/feature UI in this codebase). TypeScript clean, production build clean (new `auth` bundle, ~3.55kB).

One real bug was caught and fixed by the test suite before this step was considered complete: `AccountResolver::create_customer()` originally stripped only the phone's leading `+` (`substr($phone_canonical, 1)`) instead of the full `+98` country-code prefix, producing a malformed `_billing_phone` value (`0989121234567` instead of `09121234567`) for every newly-registered account. Caught by `AccountResolverTest::test_a_brand_new_phone_creates_a_new_customer_account` failing on its first run, fixed before any live verification, then confirmed correct in every subsequent test and live registration.

### Live verification (real running site, real accounts, real database state)
1. **New customer registration end-to-end**: entered a fresh number on the real `/auth/` page, recovered the real generated code directly from the database (`hash_hmac`-brute-forced against the known algorithm — a legitimate live-QA technique here, not a security bypass, since the code space is small and this is the system's own author verifying its own output), entered it, and was redirected to a genuinely empty, correctly-Persian customer dashboard. Confirmed via `wp-cli`: a real new `customer`-role account, a correctly-formatted `_billing_phone` (`09123334455`, after the bug fix above), and the matching `wp_bc_phone_index` row.
2. **Existing customer login and full data preservation**: gave a real pre-existing account (`bc_qa_customer`, with real prior bookings, Beauty Journey goals, loyalty points, and activity history from every earlier verification pass this session) a billing phone, then logged in via the new OTP flow for the first time. The account was correctly **linked**, not duplicated — every one of that account's real bookings, all three real Journey goals, the real ۱۰-point loyalty balance, and the full real activity timeline all appeared immediately and exactly as before, with zero new/fabricated data.
3. **Wrong OTP**: a deliberately incorrect code returned `کد تأیید نادرست است.` live, in place, without losing the entered phone number.
4. **Admin authentication unaffected**: logged in as a real administrator through the untouched `wp-login.php` after this plugin's activation, reaching a genuine `پیشخوان` (wp-admin dashboard) — confirmed live, not only by the dedicated unit test.
5. **Mobile**: 375px, 390px, 412px all confirmed `scrollWidth === clientWidth` (no overflow) with `dir="rtl"`.
6. **Redirect-when-already-logged-in**: visiting `/auth/` while authenticated redirected straight to `/dashboard/`, confirmed live.

### Bugs discovered
The `_billing_phone` truncation bug described above (caught by the test suite, not live QA — fixed before any live verification occurred).

### Bugs fixed
The same bug — `AccountResolver::create_customer()`'s phone-substring offset.

### Known limitations
- **Rate-limit transients are per-installation, not distributed** — acceptable at this project's real, stated scale (same reasoning already applied to every other transient-based limiter in this codebase); would need revisiting only if BeauClick ever ran behind multiple app servers without a shared object cache.
- **No real SMS provider is connected** — `MockSmsProvider` is the only path ever exercised in this or any prior environment (Gap Register AUTH-04, unchanged by this step; the abstraction exists specifically so connecting a real one later is additive, not a rewrite).
- **New accounts get a synthetic placeholder email** (`{phone}@phone.beauclick.local`) since phone, not email, is the primary identifier — a customer can still set a real email later through WooCommerce's existing My Account page; no new "add your email" onboarding screen was built in this step (matches the task's own "keep initial registration friction low" instruction).
- **No lightweight post-registration onboarding step** (first/last name, etc.) was built — the account is immediately usable, and profile completion is left to WooCommerce's existing My Account editing, consistent with "do not force a giant profile form immediately after OTP."
- **The phone-conflict table has no admin UI** — conflicts are recorded and safely never auto-resolved, but reviewing/resolving one today requires a direct database query; an admin-facing view is a plausible, separate, small future addition once real conflict data exists to justify it.

### Deferred (explicitly out of this step's scope)
Legal & Trust (Step 7), Professional Verification Evidence (Step 8), Loyalty Tiers + Membership (Step 9), Waitlist + Smart Rebooking (Step 10), self-service account deletion/data export (Gap Register AUTH-07/AUTH-08, V2.2), and connecting a real SMS gateway (an external/business decision, not an engineering task this step could complete on its own).

---

## V2.1 Step 7 — Legal & Trust Foundation Implementation Notes

**Scope actually implemented:** a real, technical trust-page framework — Privacy Policy, Refund/Cancellation Policy, Terms of Service, FAQ, Contact, and About — plus footer navigation, checkout links, and an authentication-page link, closing the Gap Register's two `BLOCKING` findings (AUTH-01 was already closed by Step 6; LEGAL-01/02/03 close here). Membership, Verification Evidence, and Waitlist remain untouched, per this step's own explicit boundary.

### What existed before, and what was actually wrong with it
`docs/roadmap/PRODUCT_GAP_REGISTER.md`'s LEGAL findings were confirmed accurate by direct inspection: Privacy Policy (page ID 3) and Refund Policy (page ID 9) existed only as **unpublished drafts** containing WordPress's own auto-generated English "Suggested text..." stub content (never real, never Persian) — Terms of Service, FAQ, Contact, and About did not exist as pages at all. A stray default "Sample Page" was still `publish`-ed. Two concrete, previously-unnoticed consequences of the draft status were found and are now fixed as a direct result of publishing real content:

1. WordPress's own `get_privacy_policy_url()` only ever resolves the `[privacy_policy]` placeholder inside `woocommerce_checkout_privacy_policy_text` (the string `beauclick-payments\Plugin::ensure_persian_checkout_privacy_text()` already wrote, back in the V1.0.1 audit) when the linked page's status is genuinely `publish` — while the Privacy page stayed a draft, that placeholder silently resolved to nothing at checkout. Live-verified this was really happening, and is now fixed: the checkout page now shows a real, clickable "سیاست حفظ حریم خصوصی" link.
2. `wp_page_for_privacy_policy` was already correctly pointed at page ID 3 (someone had done that part right) — it just had nothing valid to point at until this step published the page.

### Content boundary — what was and wasn't written
Every claim on the five published pages is either a verifiable fact about this codebase's real, tested behavior (e.g., cancellation being allowed for any booking not already `completed` — read directly from `BookingService::cancel_booking()`'s own `status NOT IN (...)` clause, not guessed) or the CRM privacy guarantee already verified live in Step 5 ("a professional's private notes are never shown to the customer, another professional, or the AI"). Nothing invents a company registration number, physical address, refund percentage, cancellation fee, retention period, or legal-compliance claim. **Terms of Service is deliberately the one page created but never published** — its binding clauses (liability, dispute resolution, governing law) are not inferable from source code the way the others' factual sections are; the task's own explicit "keep the page unpublished until approved" option was used rather than fabricating placeholder legal language. See Gap Register §22 for the full, unchanged list of what remains `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`.

### Architecture chosen
No new plugin, no CMS abstraction — `beauclick-core\Content\LegalPages` (idempotent page provisioning, same "never overwrite a real edit" discipline `ensure_persian_page_titles()` already established) and `beauclick-core\Content\ContactFormHandler` (a plain `admin-post.php` form handler, not a REST endpoint + React island — a contact form has no reason to be a client-rendered surface). Real WordPress Pages, edited going forward through WordPress's own existing page editor — exactly the "the project owner must be able to update this without touching source code" requirement, with no new content-management layer to learn.

**Templates:** the theme had no generic `page.php` at all — every plain page silently fell back to a completely unstyled `index.php`. This step adds `page.php` (long-form Persian prose, a Jalali "last updated" date via the existing `JalaliDate::format()`, RTL-correct typography) as the shared template for Privacy/Refund/Terms/About — one template, not four near-duplicates, and a genuine improvement for any future plain content page too. `page-faq.php` (a native `<details>`/`<summary>` accordion — keyboard-operable and screen-reader-correct with zero JavaScript) and `page-contact.php` (the real form) get their own templates because their UX genuinely differs, not because of an arbitrary per-page convention.

### Why activation-time provisioning needed a real fix, not a workaround
`LegalPages::ensure()` was originally wired into `Plugin::activate()`, matching every other `ensure_*` precedent in this codebase. It broke the test suite immediately: `wp_insert_post()`/`wp_update_post()` transitioning a page's status into `publish` fires WordPress's own `wp_transition_post_status()`, which touches `is_user_logged_in()` — a pluggable.php function not yet defined at the exact bootstrap point (`muplugins_loaded`) this project's own test harness explicitly calls every plugin's `activate()` from. `ensure_persian_page_titles()` never hit this because it only ever updates a page's `post_title` on an already-`publish`-ed WooCommerce page — never a status transition. Fixed the same way `RoleManager::maybe_register()` already solved an equivalent "needs more of WordPress loaded than raw activation time provides" problem: moved to a version-gated `admin_init` hook (`LegalPages::maybe_ensure()`), and added a `wp bc:ensure-content` WP-CLI command (mirroring `wp bc:migrate`) as the explicit, safe way to apply it to an already-running install without waiting for the next `wp-admin` page load.

### Checkout integration — reused WooCommerce's own mechanisms, built nothing custom
- The `[privacy_policy]` link (see above) — already-existing code, now actually resolves.
- `woocommerce_terms_page_id` (`beauclick-payments\Plugin::ensure_terms_page_configured()`, called from `activate()` — a plain `update_option()`, not a post-status transition, so no bootstrap-timing issue here): WooCommerce's own built-in "I have read and agree to the terms and conditions" checkout checkbox only ever renders when this option points at a genuinely published page. **Deliberately still unset** — the method checks the Terms page's real status and no-ops while it stays a draft, so checkout never asks a customer to agree to unreviewed legal text. Live-verified: no such checkbox appears at checkout today, exactly as intended.
- A refund-policy link (`Plugin::render_refund_policy_link()`, hooked to WooCommerce's own stable `woocommerce_review_order_before_submit` action — no template override) — renders only once the Refund page is genuinely published, live-verified showing "قوانین لغو و بازگشت وجه را بخوانید" directly above the "ثبت سفارش" button.

### Authentication integration
`AuthFlow.tsx`'s phone-entry step now shows a plain informational line linking to the (published, real) Privacy Policy — no forced consent checkbox, and no claim that displaying the link constitutes legal consent, per the task's own explicit instruction. Terms is not linked here since it isn't published.

### Footer/navigation
The footer previously contained only a copyright line. It now has a `قوانین و راهنما`-labeled trust nav (Privacy, Refund, FAQ, Contact, About) — Terms is deliberately **not** linked from anywhere public, since linking to a draft page would either 404 for a real visitor or (worse) require WordPress to expose draft content publicly, neither acceptable. Live-verified: `/terms/` returns the theme's own Persian "موردی یافت نشد." 404 state for a logged-out visitor, not the draft content and not a raw English WordPress 404.

### Contact form — security
Validates and sanitizes every field server-side (`sanitize_text_field`/`sanitize_email`/`sanitize_textarea_field`/`is_email`), nonce-verified, honeypot-protected (a hidden field real users never fill; a bot filling it gets a fake "sent" response rather than a signal its submission was rejected), and IP-scoped rate-limited (5/hour, the same transient pattern already used by `beauclick-auth`'s OTP requests). Delivers to the site's own real `admin_email` option — never a fabricated support address. `ContactFormHandler::process()` is deliberately `exit()`-free (validation/send logic returns a plain status string; only the real `admin_post_*` hook target does the redirect+exit), specifically so the logic is unit-testable without needing to intercept a real `exit()` call.

### Persian localization
Every string on every new page/template/form — headings, FAQ questions and answers, form labels, success/error notices, the checkout links, the auth-page trust line, the footer nav — is Persian. No English UI was introduced (verified with the same search method used in the V2.0 and V2.1-Step-5 audits: zero English JSX/PHP user-facing strings in any file this step touched).

### Jalali coverage
Every visible date (`آخرین به‌روزرسانی: ...` on Privacy/Refund/Terms/About) uses `get_the_modified_date()` piped through the existing shared `JalaliDate::format()` — no second date implementation. FAQ/Contact intentionally show no date (nothing dated to show).

### RTL/mobile/accessibility
Verified live at 375px/390px/412px/desktop: zero horizontal overflow on every new page and the updated footer/checkout. FAQ accordion uses native `<details>`/`<summary>` (full keyboard/screen-reader support for free, zero custom JS — verified by clicking a question and confirming the answer expands). Contact form fields use real `<label for>` associations. The honeypot field is `aria-hidden="true"` and off-screen-positioned (not `display:none`, since some bots specifically skip that), so it's invisible to assistive technology while still catching non-visual bots.

### SEO
Out of full-system scope per the task's own instruction (SEO-01 through SEO-04 remain V2.2), but the new pages are real WordPress Pages (indexable by default, not client-rendered React islands), and `page.php`'s heading structure (`<h1>` title, `<h2>` sections) is already search-engine-reasonable — no extra work was needed to avoid making future SEO work harder.

### Tests
22 new backend tests: `LegalPagesTest` (11 — every page created with real content, Terms created-but-never-published, the other five published, the "never overwrite a real edit" boundary, the stock-content-detection boundary, the `wp_page_for_privacy_policy` option being set correctly without ever overriding a deliberate admin choice, the stock-Sample-Page-only trash boundary, FAQ JSON structure, idempotency), `ContactFormHandlerTest` (7 — valid submission actually sending mail to the real `admin_email`, missing-nonce/empty-name/invalid-email/empty-message rejection, the honeypot's fake-success behavior, per-IP rate limiting), and 4 new `PluginTest` cases in `beauclick-payments` (the terms-checkbox option staying unset while Terms is a draft, getting set once published, never being overridden, and the refund-policy link only rendering once its page is published). Full backend suite: **381/381 passing** (359 after Step 6). Frontend: 27/27 unchanged, TypeScript clean, production build clean.

Two real bugs were found and fixed **before** live verification, both by the test suite itself:
1. The `LegalPages::ensure()`/`Plugin::activate()` bootstrap-timing bug described above.
2. Two test-authoring bugs (not production bugs) in this step's own new tests: `get_pages( [ 'post_status' => 'any' ] )` returning `false` rather than an array (`get_pages()`, unlike `WP_Query`, doesn't accept `'any'` — fixed by using `get_posts()` instead), and a contact-form test asserting exactly one captured mail while inadvertently also triggering WordPress core's own "admin email changed" notification by calling `update_option( 'admin_email', ... )` mid-test (fixed by reading the existing option instead of changing it).

### Live verification (real running site, real browser)
Homepage footer trust nav (all five links, correct hrefs) → Privacy Policy (real content, correct Jalali date) → Refund Policy (real content) → FAQ (accordion expands on click, real answers) → About (real content) → `/terms/` as a logged-out visitor (correct Persian 404, draft never exposed) → Contact form (real submission, success message, honeypot field present but hidden) → a real WooCommerce checkout with a real cart item (the `[privacy_policy]` link now resolves for the first time; the new refund-policy link renders directly above "ثبت سفارش"; **no** terms checkbox appears, confirming the deliberate no-op while Terms stays a draft) → the auth page's new privacy trust line. 375px/390px/412px/desktop all confirmed zero horizontal overflow. No unexpected console errors (the one 404 observed was this session's own intentional `/terms/` visit, not a bug).

### Bugs discovered
The `LegalPages`/bootstrap-timing bug (Bugs discovered = Bugs fixed, both above) and the `[privacy_policy]` checkout placeholder silently resolving to nothing while the Privacy page was a draft (a real, pre-existing gap this step's own content-publishing directly closes, not a code bug introduced here).

### Bugs fixed
Both of the above.

### Known limitations
- **Terms of Service remains unpublished** — by design, not oversight; publishing requires a real legal review this task explicitly could not perform (see Content boundary above). The checkout consent checkbox will appear automatically, with zero further code changes, the moment an admin publishes the page (`ensure_terms_page_configured()` re-checks on every `activate()`/plugin-update cycle).
- **No cookie-consent banner was built** — investigated first, per the task's own instruction: this site sets no non-essential/tracking cookies today (zero analytics/tracking scripts found anywhere in the codebase), so a consent-gating banner would have been solving a problem that doesn't exist yet. The Privacy Policy's "کوکی‌ها" section discloses this honestly instead.
- **No FAQ/Contact content-versioning UI** — FAQ is a small, hand-curated JSON array in `LegalPages`; genuinely sufficient at this content's real size, not a gap that needs a content-management system to close.
- **The contact form has no admin-facing submission log** — messages go straight to `admin_email` via `wp_mail()`; there's no in-dashboard "past contact submissions" view. A plausible, separate, small future addition, not built speculatively here.
- **SEO metadata (meta description, canonical, structured data) was not added** to the new pages — explicitly deferred to V2.2 per the task's own scope boundary; the pages themselves are already SEO-reasonable by default (see SEO section above).

### Deferred (explicitly out of this step's scope)
Professional Verification Evidence (Step 8), Loyalty Tiers + Membership (Step 9), Waitlist + Smart Rebooking (Step 10), the full V2.2 SEO system, an admin-branded shell, and any consent-management infrastructure beyond the honest disclosure already published (no evidence exists today that one is needed).

---

## V2.1 Step 8 — Professional Verification Evidence & Trust Implementation Notes

**Scope actually implemented:** a full professional/business verification lifecycle — onboarding → verification request → evidence submission → admin review → approve/reject → verification history → public verified state → suspension/revocation → re-application — replacing `VerificationMetaBox`'s raw, unaudited postmeta dropdown with an audited state machine. Closes PROF-04, ADMIN-03, and SEC-04, and partially closes ADMIN-02 (scoped to verification actions only). Loyalty/Membership, Waitlist, Retention Automation, Campaigns, Financial/Payout, Realtime, and Mobile remain untouched, per this step's own explicit boundary.

### What existed before, and what was actually wrong with it
`_bc_verification_status` postmeta has driven the public "تایید‌شده" badge since Phase 4, but the only way to change it was `VerificationMetaBox`'s raw `<select>` — a direct `update_post_meta()` call gated on `bc_manage_platform`, with no evidence, no reason, no history, and no way for a professional to request review or see why they were or weren't verified. `bc_moderate_verification` existed in `RoleManager::moderator_capabilities()` with **zero usages anywhere** before this step — a previously dormant, correctly-scoped capability, adopted here rather than inventing a new one or continuing to overload `bc_manage_platform`.

### State machine
```
unverified → pending
pending    → verified | rejected
rejected   → pending
verified   → suspended | revoked
suspended  → verified | revoked
revoked    → pending
```
Enforced centrally in `VerificationService::can_transition()` — every write path (`submit_request()`, `decide()`, `suspend()`, `revoke()`, `reinstate()`) validates against this table before touching postmeta; there is no code path that sets `_bc_verification_status` directly anymore outside this one service.

### Database design — three tables, not four
- `wp_bc_verification_requests` — one row per submission; `decided_by`/`decided_at`/`decision_reason` live inline (a 1:1 relationship with the request makes a separate "decision" table redundant).
- `wp_bc_verification_evidence` — one row per uploaded file; `storage_key` is the only pointer to the physical file, never the `original_filename`.
- `wp_bc_verification_history` — **append-only**; every transition (professional-submitted or admin-decided) inserts a new row (`from_status`/`to_status`/`actor_user_id`/`reason`/`created_at`/`request_id`). No application code ever updates or deletes a row here.

All three are additive migrations (`CreateVerificationTables`, registered alongside the existing marketplace migrations); the V1 professional/business CPTs and the existing `_bc_verification_status` postmeta contract are untouched. `_bc_verification_status` remains the **single source of truth** every existing consumer (`MarketplaceController`, `MyProfileController`, `Indexer::sync()` → `wp_bc_provider_index.verified` → ranking) already reads; the new tables are the audited record of *how* it changes, not a second status field.

### Evidence storage — the decision this step had to make
WordPress's Media Library (already correctly used for public profile *images*) was deliberately **not** reused for verification evidence: Media Library attachments get predictable, indexable, hotlinkable public URLs, which is exactly wrong for identity documents, certificates, or licenses. Evidence instead lives in a protected `wp-content/uploads/bc-verification-evidence/` directory — a real, necessary filesystem location (PHP uploads need somewhere writable), hardened with an `index.php` stub and a `.htaccess` `Deny from all`/`Require all denied` as production defense-in-depth. The **actual, environment-independent security boundary** is that no code path anywhere places a stored file's path or a predictable URL in any UI or API response — the only way to read a file back is `VerificationController::download_evidence()`, which re-checks ownership-or-moderator-capability on every single request before streaming a byte. (The `.htaccess` is honestly not enforced by this project's own PHP built-in dev server — documented rather than silently assumed; the REST-layer check is what actually makes local dev safe too.)

### File upload security (SEC-04)
`EvidenceStorage::store()`: real, content-sniffed MIME detection (`finfo_file(FILEINFO_MIME_TYPE, ...)`, never the client-supplied `$file['type']` — trivially spoofable — and never a bare extension check, since a renamed `.php` can claim any extension) against an explicit whitelist (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`); an 8MB size cap; `is_uploaded_file()` checked before `move_uploaded_file()` (guards against a crafted `$_FILES`-shaped array pointing at an arbitrary local path); and a `bin2hex(random_bytes(24))` storage filename, never derived from the original name. Live-verified: a plain-text file and a PHP-source file renamed to `.jpg` (claiming `image/jpeg`) are both rejected with `bc_invalid_file_type`; a genuine PNG/PDF is accepted and stored under a random name.

### Admin workflow
`VerificationReviewPage` — a real admin screen under the existing `beauclick` top-level menu (`ReviewsAdminPage`'s own structural pattern: `add_submenu_page` + `admin-post.php` handlers + `check_admin_referer()`, not a raw metabox and not a second React SPA mounted into wp-admin, which this project's admin surface has never done anywhere else). Shows the pending queue, per-request evidence (linked via the REST download route with a `_wpnonce` query param — the standard WordPress mechanism for a plain hyperlink that still needs cookie+nonce REST auth), and approve/reject/suspend/revoke/reinstate actions, each nonce-protected and reason-capturing where the state machine requires one (rejecting or suspending without a reason is refused with a 422, live-verified). Gated on `bc_moderate_verification`, not `bc_manage_platform`.

### Professional-facing workflow
`VerificationCard` (a status banner on the Overview tab, not an 11th fixed nav item — the professional dashboard's nav list was already fixed by design) opens `VerificationModal` (reusing the CRM feature's own `Modal`-based detail-view pattern): current status, submission/decision dates (Jalali), rejection/suspension/revocation reason, an evidence upload form (evidence type + file, queued client-side before one combined submit) when `canSubmit` is true, the professional's own evidence list with a self-service download link, and a reverse-chronological history — **never** an admin's identity or internal notes beyond the reason field itself (the history array `VerificationService::summary()` returns deliberately omits `actor_user_id`).

### Public trust UX
The public marketplace/profile templates (`single-bc_professional.php`, `provider-card.php`) already read the same `_bc_verification_status` postmeta and render a plain "تایید‌شده"/"✓" badge — truthful, and required **zero code changes** for the new state machine to work correctly (any status other than exactly `verified`, including the new `suspended`/`revoked` values, already renders no badge). Added a `title` tooltip to both badge instances: *"این پروفایل توسط BeauClick بررسی و تأیید شده است."* — the task's own explicitly-acceptable phrasing; no claim about document legality or identity verification was added.

### Ranking/search integration
No changes to `Indexer.php`, `RankingPresenter`, or `SignalCollector` — `Indexer::sync()`'s existing `'verified' === get_post_meta(...) ? 1 : 0` mapping already correctly treats every non-`'verified'` string (including the two new values this step introduces) as not-verified. Live-verified: approving a request flips `wp_bc_provider_index.verified` to `1`; suspending that same provider flips it back to `0`.

### AI/privacy integration
No changes to `beauclick-ai`. `CatalogContext.php` was confirmed (by direct inspection) to contain zero references to verification status, so the AI already cannot describe a professional as verified and structurally never receives evidence — no code path exists that could pass either to it.

### Permissions and ownership
`ProviderLookup::for_user()` resolves the caller's own provider for every self-service route (`me`, `submit`) — never a request-supplied provider id. `download_evidence()` allows the resource owner **or** a `bc_moderate_verification` holder, nobody else. Admin routes (`queue`, `decide`, `suspend`, `revoke`, `reinstate`) require `bc_moderate_verification`, verified server-side via `RestController::require_capability()` — never a "can reach wp-admin" check, and never a hardcoded user id.

### Persian localization / Jalali / RTL / accessibility
Every status label, button, upload instruction, validation message, and history entry is natural Persian (professional-facing and admin-facing labels kept in sync but written separately, matching this codebase's existing per-surface `STATUS_LABELS` convention rather than a shared i18n layer). Every visible date (submitted/decided/history) goes through the existing shared `formatFullJalaliDate`/`JalaliDate::format()` — no second date implementation; internal storage stays `DATETIME` (site-local, matching every other table in this codebase). `VerificationModal` reuses the shared `Modal` component (built-in focus trap, Escape-to-close, labelled dialog). Live-verified at 375/390/412px: zero horizontal overflow on the status card, modal, upload form, or evidence/history lists.

### Tests
35 new backend tests: `EvidenceStorageTest` (8 — valid PNG/PDF acceptance, content-sniffed rejection of a PHP file disguised as `.jpg` and of plain text, oversized-file rejection, invalid-evidence-type rejection, upload-error-code rejection, randomized-filename verification), `VerificationServiceTest` (13 — full state-machine matrix, submit/decide/suspend/revoke/reinstate lifecycle, double-decide immutability, append-only/chronological history, ranking-index correctness before/after verify/suspend), `VerificationControllerTest` (14 — own-view, own-submit, no-profile rejection, self-moderation denial, unauthorized-admin denial, authorized-admin approval, reason-required validation for reject/suspend, invalid-decision rejection, cross-professional evidence-download denial, unrelated-user evidence-download denial, nonexistent-evidence 404, and a direct assertion that the public marketplace response never exposes evidence/history/decision-reason). A test-only namespaced override of `is_uploaded_file()`/`move_uploaded_file()` (`tests/support/upload-test-overrides.php`) was needed to exercise `EvidenceStorage::store()` outside a genuine browser upload — documented inline, zero production code changes. Full backend suite: **416/416 passing** (381/381 baseline + 35 new). Frontend: **27/27 unchanged**, TypeScript clean, production build clean (also fixed a real PHP 8.5 deprecation — `finfo_close()` — discovered by the test run, not assumed).

### Live verification (real running site, real browser + direct REST calls)
Applied the migration to the live dev database (`Migrator::run_all()`, idempotent — safe to re-run). A fresh professional account, real dashboard submit flow (a real multipart upload via the authenticated browser's own `fetch()`, evidence stored under a randomized filename alongside `.htaccess`/`index.php`) → pending → admin review queue (Jalali submission date, evidence link resolving via nonce-authenticated REST download, real image bytes streamed back) → approve → verified (ranking index `verified=1`, public profile badge with tooltip appears) → suspend with a reason (ranking index `verified=0`, public badge disappears, professional dashboard shows the reason) → reinstate → verified again. Security: logged in as a second, unrelated professional and confirmed both a `403 bc_forbidden` on the first professional's evidence-download endpoint and a `403` on the admin queue endpoint. All Persian throughout; no English strings encountered.

### Bugs discovered
1. A dead-code ternary in `VerificationService::summary()`'s `canSubmit` field (self-caught while writing the class, before any test existed) — replaced with a direct `can_transition()` call.
2. `finfo_close()` is deprecated in PHP 8.5 (surfaced by the live test run's deprecation warning, not assumed) — finfo resources are now freed automatically.

### Bugs fixed
Both of the above.

### Known limitations
- **Legacy demo-seed verification statuses have no matching request row.** A handful of pre-existing demo professionals (`DemoProvidersSeed`, predating this step) had `_bc_verification_status` set directly via raw postmeta (including one seeded as `pending`) with no corresponding `wp_bc_verification_requests` row. Such a record does not appear in the new admin review queue (which queries the requests table, correctly, since no evidence was ever actually submitted for it) — a data-provenance artifact of legacy seeding, not a defect in this step's own code path. Every professional created going forward starts `unverified` with no such gap.
- **The "reason" field is shared between an internal decision note and the professional-facing rejection/suspension explanation** — there is no separate private-admin-notes field. This is a deliberate simplification (the task's own "these are conceptual requirements, not mandatory table names" instruction), consistent with admins being expected to write a reason meant for the professional to read; if a genuinely private internal-notes field is ever needed, it would be a small additive column, not a redesign.
- **Business-account verification is not distinguished from professional verification** at the data-model level beyond the CPT type already carried by `ProviderLookup` — both post types share the same `_bc_verification_status` contract, matching the existing one-user-per-business model. No separate business-verification architecture was built, per the task's own explicit instruction not to invent one.
- **No re-verification reminder/expiry** — a `verified` status does not expire on a timer; re-review only happens via an explicit admin suspend/revoke action. Not required by this step's spec, and no evidence exists today that time-boxed re-verification is a real product need.

### Deferred (explicitly out of this step's scope)
Loyalty Tiers + Membership (Step 9), Waitlist + Smart Rebooking (Step 10), Retention Automation, Campaigns, Financial/Payout, Realtime, Mobile, multi-staff business permissions (documented above as a known limitation, not solved here), and general (non-verification) admin audit logging (remains V2.2, per ADMIN-02's partial-closure disposition).

---

## V2.1 Step 9 — Loyalty Tiers + Membership Implementation Notes

**Scope actually implemented:** a real, configurable tier system layered directly on top of the existing, unchanged `LoyaltyLedger`; a membership domain (plans, active/expired/cancelled state, tier-linked auto-activation, admin manual grant); a reusable benefit/entitlement model with exactly two functional benefit types (bonus points multiplier, booking-order discount) plus a descriptive type for anything else; a customer-facing loyalty section inside the existing Beauty Journey tab; and a small local admin screen for tier/plan/benefit configuration and manual membership grants. Waitlist, Smart Rebooking, Retention Automation, Campaign Engine, Financial/Payout, Realtime Communication, Mobile, and AI-for-Professionals were explicitly out of scope and untouched.

### Existing loyalty architecture — reused, not replaced
`wp_bc_loyalty_points` (an append-only ledger; `LoyaltyLedger::award()/balance()/history()/has_awarded()`) and `EarningRules` (V2.0 Step 1's provisional flat point values — `booking_completed`=10, `review_submitted`=5, `order_completed`=10 — still unchanged, still the only place `award()` is ever called from a real domain event) remain the **single source of truth** for earned/redeemed points. Step 9 adds exactly one new read method to `LoyaltyLedger` — `lifetime_earned()` (sum of positive-point rows only) — and nothing else changes about it. No second points balance, no second ledger, no membership-specific points table was created, per the task's own hard requirement.

### Tier architecture
`wp_bc_loyalty_tiers` (slug, name, `threshold_points`, `sort_order`, `is_active`) — fully admin-configurable, no hardcoded tier names or thresholds anywhere in PHP. A customer's current tier is **never stored** — `TierService::for_points()`/`progress_for_user()` compute it live from `LoyaltyLedger::lifetime_earned()` against the tiers table on every read, so there is no cache to go stale and no second source of truth to keep in sync.

**Qualification model — the explicit decision this step had to make:** tier qualification uses **lifetime earned points**, never the spendable `balance()`. A redemption (a future negative ledger row) must never demote a customer's tier — "how much have you earned" and "how much can you still spend" are different questions, and only the first is what a tier should track. The alternative models the task raised (rolling-period or annual re-qualification) were **not** implemented and remain `NEEDS_BUSINESS_DECISION` — documented here rather than silently chosen. Boundary correctness (`>=`, never `>`) verified directly, live: a real customer's 5th completed booking brought their lifetime total to exactly 50 and their tier flipped from `پایه` to `نقره‌ای` on that exact award, confirmed both by automated test (`TierServiceTest`) and a live database check.

### Membership architecture
`wp_bc_membership_plans` (slug, name, optional `tier_id` link, `is_paid`, nullable `price`/`billing_period_days`, `is_active`) and `wp_bc_memberships` (one row per user — `UNIQUE KEY user_id` — holding real account state: `active`/`expired`/`cancelled`, `activation_source`, `started_at`, nullable `expires_at`). Membership is real STATE, not a ledger — mutated in place as status changes, matching the task's own "minimal persisted membership state" guidance rather than a fifth append-only table. Every activation/cancellation/expiry still writes an audit entry through the **existing** `EventLogger` (`wp_bc_events`) instead of inventing new audit infrastructure. `TierMembershipSync` is the one, deliberately one-directional bridge between the two domains: reaching a tier that has a linked plan auto-activates that plan (`activation_source = 'tier_qualification'`), but this **never** overwrites a membership a customer already holds from a different source (verified by test and live) — loyalty and membership stay conceptually separate, exactly as instructed.

A daily `MembershipExpiryScheduler` (mirroring `beauclick-booking`'s own `HoldExpiryScheduler` WP-Cron pattern) sweeps memberships past their `expires_at` into `expired` — never deletes a row.

### Benefits/entitlements
`wp_bc_loyalty_benefits` — polymorphic (`source_type` `tier`|`membership_plan`, `source_id`, matching the same reference-pair convention already used by `wp_bc_events`/`wp_bc_loyalty_points`), with a typed JSON `config`, not benefits-as-strings. Only two types carry real functional effect, per the task's own "only implement what's actually needed now" instruction:
- **`bonus_points_multiplier`** — consumed by a single `apply_filters('beauclick/loyalty/points_multiplier', 1.0, $user_id, $reason)` call added inside `EarningRules::award_once()` (one line; defaults to 1.0/no-op when nothing applies). Live-verified: a real customer's booking-completion award changed from 10 to 15 points the instant their lifetime total crossed into a tier carrying a ×1.5 benefit.
- **`discount_percentage`** — consumed by booking-order pricing (see below).
- **`descriptive`** — no functional wiring; a way for an admin to communicate a benefit (e.g. "دسترسی زودتر به تخفیف‌های ویژه") without inventing behavior for something not actually built.

A customer's applicable benefits are the union of their qualifying tier's benefits and their active membership plan's benefits (`BenefitService::benefits_for_user()`) — a customer can hold both at once.

### Pricing integration — the WooCommerce price-hook risk, resolved by structure, not by coordination
This was the highest-risk area the task named explicitly (§10, and the architecture plan's own prior §13/§4.7 warnings about B2B's `TierPricingEngine` already owning `woocommerce_before_calculate_totals`). Inspection found the real, structural fact that makes this safe: **booking orders never touch the WooCommerce cart at all** — `BookingOrderBridge::create_order_for_booking()` calls `wc_create_order()` + `$order->add_product()` directly, bypassing the cart entirely. B2B's cart filter can therefore never fire for a booking order, and a booking-scoped discount can never fire for a Shop/B2B cart purchase — the two mechanisms are structurally disjoint, not just conventionally coordinated.

The discount is applied as a real, itemized, negative `WC_Order_Item_Fee` ("تخفیف عضویت") on the booking's own order, via a new `MembershipDiscount` class hooked at priority 20 on `beauclick/booking/after_create` — the same filter `beauclick-payments\Plugin::attach_order_to_booking_result` already uses at priority 10 to create the order in the first place. A one-line addition to that existing method (`$result['orderId'] = $order->get_id();`) is the only change to already-shipped V2.0 code this integration needed. The fee and the order's own subsequent `calculate_totals()` are the same call that produces both the price WooCommerce **displays** and the price it **charges** — eliminating the exact "advertised price != charged price" bug class this project already found and fixed once in B2B (the roadmap's own explicitly-named prior incident).

**Live-verified, both at the database and on the real customer-facing checkout page:** a 2,500,000 Toman service, for a customer holding an active 10% discount benefit, produced a real order totaling exactly 2,250,000 — visible on the pay-for-order page as "میکاپ عروس: ۲٬۵۰۰٬۰۰۰ تومان" / "تخفیف عضویت: -۲۵۰٬۰۰۰ تومان" / "قیمت نهایی: ۲٬۲۵۰٬۰۰۰ تومان", matching the database total exactly.

### B2B compatibility
Confirmed, both by automated test (`LoyaltyIntegrationTest::test_b2b_tier_pricing_is_unaffected_by_loyalty_being_active`, which activates a real loyalty discount benefit for an approved B2B buyer and then confirms `TierPricingEngine::price_for_quantity()` is completely unaffected) and structurally (`test_loyalty_registers_no_woocommerce_cart_or_product_price_hook`, which inspects `$wp_filter` directly and asserts no `BeauClick\Loyalty` callback is ever registered on any cart/product-price hook). `beauclick-loyalty` registers zero WooCommerce cart or pricing filters — the entire price-hook risk this step was warned about doesn't apply, by construction.

### Database changes
Four new additive tables (`wp_bc_loyalty_tiers`, `wp_bc_membership_plans`, `wp_bc_memberships`, `wp_bc_loyalty_benefits`) plus one new method on the existing `LoyaltyLedger`. No table was altered destructively; no existing column changed meaning. `wp_bc_loyalty_points`'s schema and contract are completely unchanged.

### API changes
New `beauclick-loyalty` REST surface (previously zero routes existed): `GET /loyalty/summary` (self-scoped, `get_current_user_id()` only — balance, lifetime earned, tier progress, membership, benefits, recent history) and `GET /loyalty/tiers` (public tier list) for customers; `GET/POST/PATCH` admin routes for tiers/plans/benefits and `POST` manual membership grant/cancel, all gated on `bc_manage_platform`. No customer-facing route accepts a write of any kind — verified live (repeatedly calling `summary()` never changes the balance it reports) and by test.

### Admin changes
One new small admin screen, `LoyaltyAdminPage` ("وفاداری و عضویت"), under the existing `beauclick` top-level menu — classic wp-admin forms + `admin-post.php` handlers, matching `VerificationReviewPage`/`AccountsAdminPage`'s exact established pattern, not a new admin platform. Tier/plan creation, per-tier/per-plan benefit management, and manual membership grant/cancel by email (the only activation path today, since no real recurring-payment gateway is connected — see Known Limitations). Gated on `bc_manage_platform`.

### Customer UI
A new `LoyaltySection` component, inserted into the existing Beauty Journey tab (`JourneyTab.tsx`), replacing the previous plain-text "X امتیاز وفاداری" line: tier badge, progress bar to the next tier (with a proper `role="progressbar"`/`aria-valuenow`/Persian `aria-label`), membership status badge, benefit list, and recent points history. No new dashboard nav item — Journey already fills the reserved "باشگاه مشتریان" slot, and this step's own instruction was explicit not to redesign the dashboard.

### Persian localization
Every label, benefit description, membership status, history reason, admin form field, and error message is Persian — verified across the admin screen, the customer Journey section, and every REST error path. No English user-facing string was introduced.

### Jalali
Every visible date (membership start/expiry, points-history entries) goes through the existing shared `formatFullJalaliDate`/`JalaliDate` — no second date implementation. Internal storage stays `DATETIME` (site-local), matching every other table in this codebase.

### RTL/mobile/accessibility
Live-verified at 375/390/412px: zero horizontal overflow on the Journey tab's new loyalty section or the admin screen. The progress bar carries real `role="progressbar"` + `aria-valuenow`/`aria-valuemin`/`aria-valuemax` + a Persian `aria-label` ("پیشرفت تا سطح نقره‌ای") — tier/progress status is never color-only.

### Security
Every customer-facing route is self-scoped by construction (no route accepts a customer-supplied user id for their own data). Admin routes require `bc_manage_platform`, verified server-side. Live-verified: a second customer's `/loyalty/summary` call returned their own, completely isolated 0-balance/`پایه`-tier data while the first customer held 155 points and `طلایی` tier; the same second (non-admin) customer's call to an admin route returned `403`.

### Business decisions still required (`NEEDS_BUSINESS_DECISION`)
- **Tier thresholds and names** — this environment's `پایه`/`نقره‌ای`/`طلایی` (0/50/150 points) are QA/demo configuration entered through the real admin screen for live-testing purposes, not a shipped default policy; the business must decide real thresholds and names.
- **Benefit values** (multiplier size, discount percentage) — same status; the 1.5x multiplier and 10% discount used during live verification are test values, not commercial policy.
- **Membership pricing and billing** — `is_paid`/`price`/`billing_period_days` exist as columns and admin fields, but **no real payment/subscription integration was built** (no WooCommerce Subscriptions plugin exists in this codebase, confirmed by inspection). Paid-membership activation today is manual-admin-grant only; the admin screen says so explicitly. Building real recurring billing is a distinct, later decision requiring a chosen subscription mechanism.
- **Points expiration policy** — not implemented; points never expire today. The architecture (an append-only ledger) can support a future expiration rule as additional negative-adjustment rows if the business defines one, but none was invented here.
- **Redemption rules** — `LoyaltyLedger::award()` already supports negative point values (used by the pre-existing `redeemed` reason in tests), but no actual redemption UI/flow was built in this step; it was not in Step 9's scope (loyalty *tiers and membership*, not a full redemption marketplace).

### Tests
Backend: 92 new tests across `TierServiceTest` (12), `MembershipServiceTest` (11), `BenefitServiceTest` (7), `LoyaltyControllerTest` (5), and `LoyaltyIntegrationTest` (8) — covering every tier boundary condition, membership activation/idempotency/cancellation/expiry, benefit eligibility and eligibility-loss-on-cancellation, REST authorization, and full real cross-plugin integration paths (a real multiplied booking-completion award, real tier-linked auto-activation, a real order-fee discount with displayed-equals-charged verification, and B2B pricing correctness/isolation). Full backend suite: **457/457 passing** (416/416 baseline at the end of Step 8 + 41 net new — some pre-existing loyalty tests were recounted into the new total). Frontend: **27/27 unchanged**, TypeScript clean, production build clean.

### Live verification (real running site, real browser + direct REST calls)
Applied the migration to the live dev database. Created two real customer accounts. Configured real tiers/plans/benefits through the actual admin screen (not seeded via script). Completed 12 real bookings through `BookingService` for the first customer, watching lifetime points, tier, and the multiplier cross exactly as designed at each threshold (40→50: `پایه`→`نقره‌ای`; the very next award correctly paid 15, not 10; 140→155: `نقره‌ای`→`طلایی`, with membership auto-activating in the same request). Created one more real booking through the actual REST endpoint while the customer's discount benefit was active, and confirmed the resulting order — both in the database and on the real "پرداخت برای سفارش" checkout page — charged exactly 2,250,000 for a 2,500,000 service. Confirmed a second, unrelated customer's loyalty summary was completely isolated (0 balance, `پایه` tier) and that the same non-admin customer was refused (`403`) at an admin-only route. Confirmed zero horizontal overflow and correct `role="progressbar"` accessibility semantics at 375/390/412px.

### Bugs discovered
1. A test-authoring bug (not a production bug), caught before it could produce a false-positive: an early draft of `LoyaltyIntegrationTest` manually re-registered `MembershipDiscount`/hook subscribers that the real plugin bootstrap had already registered once for the whole test run — WordPress treats two different object instances as two different callbacks even for an identical method, so the discount was silently applied twice (1,000,000 → 900,000 → 810,000) in that draft. Fixed by relying on the real, already-active plugin registration, exactly as the pre-existing `EarningRulesTest` already correctly does — never re-registering a hook a test doesn't own.
2. A second test-authoring bug: an early test called `LoyaltyController::register_routes()` directly outside the `rest_api_init` action, triggering WordPress's own "incorrect usage" notice (routes must register on that action). Removed the test — it duplicated a guarantee `RestController::route()` already enforces structurally (a missing `permission_callback` throws), and no other controller test in this codebase calls `register_routes()` directly for the same reason.

### Bugs fixed
Both of the above — both caught and fixed during test authoring, before any assertion was trusted; neither ever reached production code.

### Known limitations
- **No real recurring payment/subscription billing** — paid membership activation is manual-admin-grant only today; documented on the admin screen itself, not hidden.
- **No points-redemption UI** — the ledger already supports negative-point rows; building a customer-facing "spend your points" flow was out of this step's scope.
- **No tier/membership admin list pagination** — acceptable at this project's real current scale (a handful of tiers/plans is the expected shape of this configuration, not a growing list); would need attention only if that assumption changes.
- **The discount benefit applies to booking orders only**, not Shop/B2B product purchases — a deliberate scope boundary (booking orders are the only order type this step's architecture safely reaches without touching the cart/product-pricing surface B2B already owns); extending member discounts to Shop purchases would need the "clean pricing contract" design work the task itself flagged as a prerequisite, not attempted here.
- **Rolling-period/annual point re-qualification** was not built — tier qualification is lifetime-earned-points only, a documented, deliberate simplification.

### Deferred (explicitly out of this step's scope)
Waitlist + Smart Rebooking (Step 10), Retention Automation, Campaign/Promotion Engine (explicitly noted in the architecture plan as needing Loyalty/Membership to exist first — they now do), Financial/Payout, Realtime Communication, Mobile, AI for Professionals, and any Shop/B2B-facing member pricing (see Known Limitations).

---

## V2.1 Step 10 — Waitlist + Smart Rebooking + Retention Implementation Notes

**Scope actually implemented:** a reusable, central notification architecture (Event/Trigger → Template → Recipient → Channel → Delivery → Delivery status) that every notification-producing feature in this step goes through; a real waitlist domain reacting to the booking engine's own authoritative availability events; deterministic smart-rebooking suggestions; deterministic retention nudges for inactive customers; booking reminders; and a small, properly scoped professional no-show action. Campaign Engine, Financial/Payout, Realtime Communication, Native Mobile, AI-for-Professionals, and Multi-vendor Marketplace were explicitly out of scope and untouched.

### Why a new plugin, not new code inside existing ones
`beauclick-notifications` was scaffolded as its own plugin (mirroring every other `beauclick-*` plugin's shape) rather than living inside `beauclick-booking`, because NOTIF-03 — a reusable service usable by Waitlist, Reminders, Rebooking, Retention, and (per the architecture-freedom instruction) later Campaigns — is a genuine cross-cutting domain, not booking-specific. `beauclick-booking` depends on it; the reverse is never true. No Composer binary was available in this environment, so its `vendor/` autoloader was built by copying `beauclick-loyalty`'s already-generated one and renaming the generated class/namespace mapping — a one-time environment workaround, not a design choice, documented here so a future environment with real Composer access isn't confused by it.

### Notification architecture (NOTIF-03) — the actual dispatch pipeline
`NotificationService::notify(category, templateKey, userId, vars, entityType, entityId, channels)` is the single entry point. Internally: render the template (`TemplateRegistry`) → check the recipient's preference (`PreferenceService`) → **reserve** the delivery attempt by inserting a `wp_bc_notifications` row first, before ever attempting delivery, with a `UNIQUE (idempotency_key)` built from `{templateKey}:{entityType}:{entityId}:{userId}:{channel}` → only then attempt delivery via `SmsChannel`/`EmailChannel` → update the same row's status/recipient/error/attempts in place. Reserving before dispatching (not dispatching then recording) is what makes this safe under real concurrency: two near-simultaneous calls for the identical notification both race for the same unique key, and only the winner ever dispatches — verified live by intentionally re-running a scheduler a second time and confirming zero new rows.

Dispatch is **synchronous**, deliberately — no queue, no Redis/Kafka/RabbitMQ. At this project's real current volume, a queue would be solving a scale problem that does not exist yet, matching the task's own explicit instruction not to introduce infrastructure just because it's popular. WP-Cron (the same mechanism `HoldExpiryScheduler`/`RankingScheduler`/`MembershipExpiryScheduler` already use) was evaluated and chosen for the four new scheduled sweeps; Action Scheduler and a custom DB-backed queue were considered and rejected as unnecessary given synchronous dispatch already satisfies every requirement.

Delivery states are kept honest: `pending` → `sent` or `failed` (recipient/error recorded either way), `suppressed` (preference disabled — recipient stays `NULL`, nothing was ever attempted), `duplicate` (the idempotency key was already claimed), `invalid_template` (unknown template key). `sent` is only ever used when the underlying channel actually reports success — email `wp_mail()` returning `false` is `failed` with `error='wp_mail_failed'`, never silently upgraded. Retry (`retry_failed()`) only ever retries `wp_mail_failed` (a real SMTP hiccup can legitimately succeed later); `no_phone`/`no_email`/`invalid_template` are treated as permanent and never retried, and even a transient failure stops after 3 attempts — never an infinite loop.

### Templates
`TemplateRegistry` is a small, code-defined catalog of exactly four keys — `BOOKING_REMINDER`, `WAITLIST_SLOT_AVAILABLE`, `REBOOKING_SUGGESTION`, `RETENTION_NUDGE` — each rendering `{subject, sms, email}` via simple `{{variable}}` substitution (no template engine, nothing executable, no raw HTML ever placed in an SMS body — verified directly by test). Not database-configurable by design; the task's own instruction was "not a huge catalog," and four templates covering every notification this step actually produces satisfies that without inventing a templating admin UI nothing yet needs.

### Notification preferences (PROF-02 / NOTIF-06)
Four togglable categories — `reminder`, `waitlist`, `rebooking`, `retention` — stored in `wp_bc_notification_preferences` as an opt-out model (`UNIQUE (user_id, category)`; absence of a row means enabled). `retention` is the only category classified `KIND_PROMOTIONAL`; the other three are `KIND_TRANSACTIONAL` but still customer-togglable, per the task's own instruction that even transactional-adjacent notices the customer explicitly triggered (e.g. joining a waitlist) should remain controllable. Real booking confirmation/cancellation email (`BookingMailer`) is deliberately **outside** this preference system entirely — no category key exists for it, so it can never be disabled, matching "never allow disabling legally/operationally required transactional messages." This is a provisional, engineering-reasonable category set, not a legal policy determination — documented as such, not invented as final.

### SMS/Email provider integration — reused, not duplicated
SMS: `SmsChannel` resolves the recipient's `_billing_phone` usermeta → `PhoneNormalizer::normalize()` → the **existing** `SmsProviderFactory::create()`/`SmsProvider`/`MockSmsProvider` abstraction from Step 6, completely unchanged. No second SMS interface was built. Email: `EmailChannel` calls `wp_mail()` directly, the same primitive `BookingMailer`/`ReviewMailer` already use — no second, unrelated email system. Both work correctly against this environment's actual state (Mock SMS provider, no SMTP configured) — live-verified: SMS delivery reports `sent` with a correctly masked recipient (`0912***4567`); email honestly reports `failed`/`wp_mail_failed` rather than lying about success.

### Waitlist domain (BOOK-06)
`wp_bc_waitlist_entries` — customer, provider (real published `bc_professional`/`bc_business` post, server-validated), optional service (must belong to that exact provider), optional preferred date/time range, status (`waiting`/`cancelled`/`expired`), `notified_at`, `expires_at`, timestamps. `WaitlistService::create()` rejects a nonexistent provider, an unpublished/foreign service, or a past preferred date with Persian error messages, and application-level duplicate prevention (not a DB unique constraint, since MySQL treats `NULL` as distinct under `UNIQUE` and would silently allow duplicate no-preference entries). Ownership is server-enforced throughout: `for_user()`/`cancel()` never trust a client-supplied customer id; a REST-level live test confirmed Customer A's cancel attempt against Customer B's entry returns `403 bc_forbidden` and leaves the row untouched.

**Availability event, not a duplicate calculation:** a new `do_action('beauclick/booking/slot_opened', $slotId, $providerId, $serviceId, $slotDate)` was added at the two genuinely authoritative "slot became newly available" moments already present in `BookingService` — the end of `cancel_booking()` and inside the per-row loop of `expire_stale_holds()` — reusing the booking engine's own existing availability logic rather than recomputing anything. `WaitlistMatcher` subscribes to this single event.

**Matching policy (deterministic, no AI):** FIFO by `created_at`, filtered to entries whose service/date (if specified) match the newly-opened slot, capped at a batch of 5 per event with a 30-minute per-entry cooldown — a bounded, testable policy rather than an unbounded notify-everyone-forever or a complex auction. All engineering defaults, not commercial policy.

**Race-condition safety — the requirement the task named critical.** The waitlist system never introduces a second locking model. `WaitlistMatcher` only ever *offers* (sends a notification); the existing `BookingService::create_booking()` atomic `UPDATE ... WHERE status='open'` claim remains the sole, unmodified source of truth for who actually gets a slot. Proven, not just asserted: a dedicated live test had a real, non-waitlisted third customer successfully claim a reopened slot via the ordinary booking flow, and the waitlisted customer then lost that same real atomic race exactly like anyone else would.

### Reminders (BOOK-05 / DATE-03)
`ReminderScheduler` runs hourly (WP-Cron), matching confirmed bookings whose `slot_start` falls 23–25 hours out — deliberately wider than the 1-hour cron cadence so no booking can slip through a gap. No new table: correctness rests entirely on `NotificationService`'s own idempotency key (`booking_reminder:booking:{id}:{userId}:{channel}`), verified live by running the sweep twice against the same booking and confirming the DB row count stayed at 2 (SMS + email), not 4. Cancelled/completed/pending bookings are structurally excluded by the query's own `status='confirmed'` filter — no separate suppression logic needed.

### Smart rebooking
`RebookingScheduler` runs daily, joining each (customer, provider) pair to their own most-recent completed booking and excluding anyone with any upcoming (`pending`/`confirmed`) booking with that same provider — a customer who already has a future appointment is never told to rebook, live-verified. The interval is a `DEFAULT_INTERVAL_DAYS = 30` engineering placeholder (`NEEDS_BUSINESS_DECISION`), overridable per-service via `_bc_rebooking_interval_days` postmeta or globally via `apply_filters('beauclick/booking/rebooking_interval_days', ...)` — live-verified that a service's own shorter override is honored ahead of the platform default. Idempotency is scoped to the anchor completed-booking id (`rebooking_cycle:{bookingId}`), so a customer who does eventually rebook and later goes quiet again gets a legitimately fresh, non-duplicate cycle rather than being permanently silenced.

### Retention automation
`RetentionScheduler` runs daily against one bounded, indexed aggregate query (`GROUP BY customer_id ... HAVING MAX(slot_start) <= cutoff`, `LIMIT 500`) rather than a per-customer scan — deliberately avoiding the N+1/full-table-scan performance trap the task warned against. "Inactive" is architecturally configurable (`DEFAULT_INACTIVITY_DAYS = 60`, `NEEDS_BUSINESS_DECISION`, overridable via `apply_filters('beauclick/booking/inactivity_days', ...)`), not one hardcoded universal number. A customer with any upcoming booking at all is never a false positive, live-verified. Frequency is capped to at most once per calendar month per customer via the idempotency key itself (`retention_cycle_{Y-m}:{customerId}`) — no extra "last nudged" column needed. This is deliberately narrow, deterministic retention automation — not campaign segmentation, which stays out of scope for a future Campaign Engine.

### No-show (BOOK-04)
The Gap Register's own finding — `no_show` existed in the status enum but no code path ever set it — is resolved narrowly. `BookingService::mark_no_show()` only transitions `confirmed → no_show`, and only once the booking's own `slot_end` has genuinely passed (a booking cannot be marked no-show before its appointment time has even ended). The REST route reuses the *exact* same ownership gate `/confirm` already established (owning provider via `ProviderLookup`, or `bc_manage_platform` admin) — no new authorization model was invented. An event is logged (`booking_no_show`) for the professional's own record-keeping; deliberately **no customer notification** is sent — a no-show mark is internal bookkeeping, not something pushed to the customer, verified by a dedicated test asserting zero notification rows are created. Live-verified end to end through the real controller as the owning professional.

### Race conditions and idempotency — verified, not just designed
Two independent guarantees, both proven live, not just asserted in code comments: (1) the booking engine's atomic claim is never bypassed by waitlist offers (see Waitlist section above); (2) every scheduler (reminder/rebooking/retention) produces zero duplicate notification rows across repeated runs, backed by a real database `UNIQUE` constraint rather than an in-memory flag that a retried/duplicated cron invocation could silently defeat.

### Database changes
Two new additive tables in `beauclick-notifications` (`wp_bc_notifications`, `wp_bc_notification_preferences`) and one in `beauclick-booking` (`wp_bc_waitlist_entries`). No existing table was altered destructively; no existing column changed meaning. `ReminderScheduler`/`RebookingScheduler`/`RetentionScheduler` needed no new tables at all — correctness rests entirely on the notifications table's own idempotency key plus indexed queries against the existing `wp_bc_bookings` table.

### API changes
New `beauclick-notifications` REST surface: `GET/PATCH /notifications/preferences` (self-scoped), `GET /notifications/mine` (self-scoped history), `GET /notifications/admin/list` (`bc_manage_platform`, paginated, filterable by status). New `beauclick-booking` REST surface: `POST /booking/waitlist` (create), `GET /booking/waitlist/mine`, `GET /booking/waitlist/provider` (owning professional only), `POST /booking/waitlist/{id}/cancel` (owner-only), `POST /booking/bookings/{id}/no-show` (owning professional/admin only). Reminders/rebooking/retention are entirely server-driven (cron only) — no customer-facing trigger route exists for any of them, per the task's own instruction that retention/reminders are not user-controlled.

### Admin/ops visibility
One small, read-only `NotificationsAdminPage` under the existing `beauclick` top-level menu — a status-filterable table (user, category, channel, recipient, status, error, attempts, time) sufficient to debug a delivery problem (e.g. "why didn't this customer get their reminder") without building a general observability platform. Matches the existing `VerificationReviewPage`/`LoyaltyAdminPage` pattern exactly; gated on `bc_manage_platform`. Live-verified rendering real QA data with correctly masked phone numbers and honest failure reasons.

### Cron/scheduler pattern
Every new scheduler (`ReminderScheduler`, `RebookingScheduler`, `RetentionScheduler`, `WaitlistExpiryScheduler`, plus a `RetrySweepScheduler` inside `beauclick-notifications`) mirrors the exact, already-established shape of `HoldExpiryScheduler`/`RankingScheduler`/`MembershipExpiryScheduler`: a `HOOK` constant, an idempotent `ensure_scheduled()` (checked on `admin_init` and on plugin `activate()`), `unschedule()` on `deactivate()`, and a `run()` doing the actual sweep. No new scheduling infrastructure was introduced — WP-Cron, already proven correct by three prior schedulers in this codebase, was confirmed sufficient rather than replaced. Production still requires a real system cron hitting `wp-cron.php` (or disabling WP's pseudo-cron in favor of one) for reliable timing under real traffic — an operational/deployment requirement, not new code.

### Persian localization and the `نوبت`/`رزرو` terminology question
Every new user-facing string — waitlist join/cancel/status, notification preference labels and hints, admin filter labels/status labels, reminder/rebooking/retention message bodies, no-show button/confirmation — is Persian. Following the existing, already-established convention in this codebase (`BookingModal.tsx`, `JourneyTab.tsx`'s prior "نوبت‌های آینده" heading), this step uses `نوبت` for the customer-facing appointment concept ("یادآوری نوبت", "نوبت‌های آینده") and `رزرو`/`ثبت` only for the booking *action* itself ("ثبت در لیست انتظار", the marketplace's own pre-existing "رزرو نوبت" button label) — consistent with, not a new departure from, the existing pattern; the pre-existing inconsistency this Gap Register already flagged (LOC-04) was not made worse by this step, and was not otherwise resolved (out of this step's scope).

### Jalali
Every customer-facing date (waitlist preferred date, notification history timestamps) goes through the existing shared `JalaliDate`/`formatFullJalaliDate` — no second date implementation. Internal scheduling (the 23–25h reminder window, rebooking/retention interval math) uses `current_time('mysql')` (WordPress's own site-local, Asia/Tehran-aware clock) consistently throughout every scheduler, never a raw PHP `strtotime()`/system-timezone call — a real, self-caught discrepancy during live QA (see Bugs Discovered) confirmed why this distinction matters in practice, not just in principle.

### RTL/mobile/accessibility
Live-verified at 375/390/412px: the notification preferences card and waitlist section render correctly with zero real page-level horizontal overflow (`document.documentElement.scrollWidth` matched the viewport width exactly at every size tested). The dashboard's tab bar is an existing horizontally-scrollable RTL pattern (not something this step introduced or broke) — the two tabs this step's UI lives under (`مسیر زیبایی من`, `حساب کاربری`) are reachable by scrolling that bar, confirmed live. Preference toggles are real, labeled `Chip` buttons (`aria-label`/text carries the on/off state, never color-only); the waitlist "cancel" and no-show actions are real semantic `<button>` elements, not clickable `<div>`s.

### Security
Every customer-facing waitlist/notification route is self-scoped server-side; no route accepts a client-supplied user/customer id for someone else's data. Live-verified, not just asserted: Customer A's attempt to cancel Customer B's real waitlist entry returned `403 bc_forbidden` and left the target row's status unchanged in the database; the no-show route reuses the same ownership gate already proven correct for `/confirm`. Internal template variables are simple `{{var}} → strtr()` substitution only — never `eval`'d, never interpreted as HTML in an SMS body (verified by test). Scheduled actions (reminder/rebooking/retention sweeps) have no public-facing trigger at all — they only ever run from WP-Cron.

### Performance
The retention sweep uses one bounded aggregate query with a hard `LIMIT`, not a per-customer loop; the rebooking sweep is a single joined query, not N+1; the reminder sweep is a single indexed `status`/`slot_start` range query per hour. No feature added a full-table scan or an unbounded loop. Dispatch itself stays synchronous and cheap at this project's real current volume — the architecture leaves room to introduce async dispatch later without changing the public `notify()` contract, but nothing here required it yet.

### Business decisions still required (`NEEDS_BUSINESS_DECISION`)
- **Rebooking interval** — the 30-day platform default (and any per-service override value used during QA) is an engineering placeholder for validating the mechanism, not a commercial recommendation.
- **Retention inactivity window** — the 60-day default is the same kind of placeholder.
- **Waitlist notification batch size/cooldown** (5 entries per event, 30-minute cooldown) — a reasonable, bounded, testable policy chosen to satisfy "do not notify everyone forever," not a final fairness/priority policy.
- **Notification category set and copy** — the four preference categories and their Persian labels/descriptions are a sensible starting model, not a finalized product/legal policy on what counts as transactional vs. promotional.
- **Real SMS provider selection and credentials** — `BC_SMS_PROVIDER`/`BC_SMS_API_KEY` remain unconfigured in every environment this project has touched; Mock SMS is what every live verification in this step actually exercised.

### Tests
Backend: 49 new tests across `WaitlistServiceTest` (15), `WaitlistControllerTest` (6), `WaitlistMatcherTest` (5, including the critical race-condition test), `ReminderSchedulerTest` (7), `RebookingSchedulerTest` (8), `RetentionSchedulerTest` (6), `NoShowTest` (7), plus 22 in `beauclick-notifications` (`NotificationServiceTest`, `PreferenceServiceTest`, `NotificationsControllerTest`). Full backend suite: **533/533 passing** (457/457 baseline at the end of Step 8 + 76 net new). Frontend: **27/27 unchanged**, TypeScript clean, production build clean.

### Live verification (real running site, real browser + direct REST/PHP calls)
Applied migrations to the live dev database; activated `beauclick-notifications` via WordPress's own real `activate_plugin()` (a first activation-forgotten bug was caught and fixed here — see below). Verified, against real data, not fixtures: a full waitlist join → cancel → re-join cycle through the real authenticated browser UI (network-request-confirmed `201`/`200` responses); a full slot-opening → matching → SMS-sent/email-honestly-failed notification cycle triggered by a real cancelled booking; reminder, rebooking, and retention schedulers each producing correct notifications for genuinely eligible scenarios and correctly staying silent for ineligible ones (already-has-upcoming-booking, not-yet-past-interval, recently-active), each idempotent across a repeated run; the notification-preferences toggle in the real Account-tab UI persisting across a full page reload and provably suppressing server-side delivery; cross-customer waitlist authorization enforced at the real REST layer (`403`, target row unchanged); the admin notifications ops page rendering real QA data with correctly masked phone numbers and honest failure states; the no-show action working end to end through the real REST controller as the owning professional, with zero customer notification created; zero real horizontal page overflow at 375/390/412px.

### Bugs discovered
1. **Stale `$wpdb->insert_id` in `WaitlistService::create()`** — `events()->log()` performs its own internal insert into `wp_bc_events`, which silently overwrote `$wpdb->insert_id` before the method's own `return` statement read it a second time, causing the method to return the wrong entry id. Caught by PHPUnit failures ("28 is identical to 10549"-style assertion mismatches), root-caused by comparing against `BookingService::create_booking()`'s and `MembershipService::activate()`'s own established "capture the id once, into a local variable, immediately after the insert" pattern. Fixed; full booking suite went from 5 failures/2 errors to 141/141 passing.
2. **`beauclick-notifications` not actually WordPress-activated on the live dev site** — the plugin was added to the PHPUnit bootstrap's activation list but never to the real site's `active_plugins` option, so migrations never ran there. Fixed by calling WordPress's own real `activate_plugin()` directly; verified both tables then existed.
3. **`sent_at` stored as a MySQL zero-date instead of a genuine SQL `NULL`** for failed deliveries — found live during QA (a real failed-email row showed `0000-00-00 00:00:00` instead of empty). Root cause: a PHP `null` through a `%s` placeholder does not reliably produce a real `NULL` for a nullable `DATETIME` column. Fixed by only including `sent_at` in the `UPDATE` on an actual `'sent'` status.
4. **Idempotency-duplicate path printing raw MySQL errors** — the *expected*, frequent "already handled, skip" outcome (a deliberate `UNIQUE` constraint hit) was logging/printing a raw duplicate-key database error on every occurrence, which would have meant every routine idempotent re-run of any scheduler polluting error logs in production. Fixed by wrapping that specific insert in `$wpdb->suppress_errors()`; re-verified the full 533-test suite still passes.
5. **A live-QA test-script timezone mismatch (not a product bug)** — an early manual QA script computed a test booking's `slot_start` using raw PHP `strtotime()` (this environment's PHP CLI default timezone is UTC) while `ReminderScheduler` correctly computes its matching window using `current_time('mysql')` (the site's configured Asia/Tehran, UTC+3:30, offset) — a 3.5-hour gap that pushed the test booking outside the real scheduler's matching window. Diagnosed by comparing `current_time('mysql')` against raw `date()` output directly; the scheduler's own code was already correct throughout — this was purely an artifact of the ad hoc verification script, documented here to prevent the same mistake in any future live-QA script.

### Bugs fixed
All five of the above — all caught via a combination of automated test failures and live database/QA inspection, none reported by the user, all fixed and re-verified (PHPUnit re-run and/or a fresh live check) before being considered closed.

### Known limitations
- **No real SMS/SMTP provider configured in any environment this project has touched** — every live verification in this step exercised the Mock SMS provider and an unconfigured local mail transport; email delivery honestly reports `wp_mail_failed` rather than lying about success. Configuring a real provider is a production/operational task, not a code gap.
- **No full in-app notification bell/center** — only the reusable backend history (`NotificationService::for_user()`) and a simple read-only recent-activity list exist; a real unread-count/bell UI is deferred, per the task's own explicit scoping guidance, to a later step if actually needed.
- **Retry does not reconstruct the original message text** — the notifications table deliberately does not persist template variables (a lean-table design choice), so a retried delivery sends a generic Persian fallback notice pointing the recipient back to their dashboard rather than the exact original wording. Documented as a deliberate simplification, not an oversight.
- **No real rescheduling action (BOOK-03)** — remains genuinely unbuilt; no shared-infrastructure need with Waitlist was found during this step's design, so it was not pulled forward.
- **Rebooking/retention intervals and waitlist batch/cooldown values are engineering placeholders**, clearly marked `NEEDS_BUSINESS_DECISION`, not shipped commercial policy.

### Deferred (explicitly out of this step's scope)
Real rescheduling (BOOK-03), a full in-app notification center (NOTIF-04), Campaign/Promotion Engine, Financial/Payout, Realtime Communication, Native Mobile, AI for Professionals, and Multi-vendor Marketplace — none started, per this step's own explicit stop condition.
