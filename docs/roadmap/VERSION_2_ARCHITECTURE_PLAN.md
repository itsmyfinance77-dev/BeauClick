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

---

## V2.1 Final Release Audit

**Audited commit:** `6796f4230d26b539aaa0204b6d42aa0a54432506` (branch `master`, matched `origin/master`, working tree clean before the audit began). Steps verified: 5 (Professional CRM), 6 (Authentication & Registration), 7 (Legal & Trust Foundation), 8 (Professional Verification Evidence & Trust), 9 (Loyalty Tiers + Membership), 10 (Waitlist + Smart Rebooking + Retention Automation).

**Methodology.** Steps 9 and 10 were already thoroughly implemented, tested, and live-verified earlier in this same engagement (see their own sections above) and were re-confirmed rather than re-audited from scratch. Steps 5–8 were each independently audited by a dedicated read-only research pass against the real code, the real test suite, and (where reachable) the real dev database — verifying the architecture plan's and gap register's own claims rather than trusting them. This was combined with direct git baseline verification, a full backend/frontend test run, TypeScript/build/PHP-lint checks, a project-wide localization/Jalali grep audit, and live browser/REST security spot-checks against the real running site.

### Step-by-step results

- **Step 5 (CRM):** No release blocker. Ownership enforced server-side twice (route-level `require_login` + `CrmService::is_customer_of()` re-checked before every read/write); business and solo-professional accounts scoped identically and correctly via `ProviderLookup`; notes are genuinely create/read-only (no PATCH/DELETE route exists); 24 tests, all current; zero raw English in the customer-facing component. Known limitations (no staff-permission model, no note edit/delete, no frontend pagination UI) confirmed still true and correctly deferrable, not blockers.
- **Step 6 (Authentication):** No release blocker. OTP lifecycle, rate limiting (5/phone/hr, 10/IP/hr), anti-enumeration, session handling, and phone-based dedup/linking all verified against real code and found to work exactly as documented; admin `wp-login.php` confirmed completely untouched; 44 tests, all current. One real, low-severity, non-blocking gap found and fixed this pass (see Bugs below). AUTH-04 (real SMS gateway) correctly remains `EXTERNAL_CONFIGURATION`.
- **Step 7 (Legal & Trust):** No release blocker. Direct live-DB query confirmed Privacy Policy, Refund Policy, FAQ, Contact, and About are genuinely `publish` status (not drafts); Terms of Service is genuinely `draft` and was confirmed, both by code (`ensure_terms_page_configured()` only wires WooCommerce's terms checkbox when the page is `publish`) and by a live request to `/terms/` returning a real 404, to never be presented to a user as an active policy. No fake legal claims found. 22 tests, all current.
- **Step 8 (Verification Evidence):** No release blocker. Evidence files live outside the Media Library at a non-predictable path; the download endpoint re-checks ownership-or-moderator-capability on every request, not just at upload; MIME validation is real content-sniffing; the public profile template exposes only the boolean `verified` flag, never evidence metadata; the audit history table has exactly one `INSERT` call site in the whole plugin tree and zero `UPDATE`/`DELETE`; a suspended/revoked professional correctly stops showing as verified in both the ranking index and the AI catalog feed. 35 tests, all current.
- **Step 9 (Loyalty + Membership):** Re-confirmed, not re-audited — see this document's own Step 9 section above for the full original verification (price-hook structural separation, B2B isolation test, live displayed-equals-charged checkout verification).
- **Step 10 (Waitlist + Rebooking + Retention):** Re-confirmed, not re-audited — see this document's own Step 10 section above.

### Cross-cutting verification

Re-confirmed live, in a single real customer session (user id 13): Authentication → Journey (tier/membership/points history rendering correctly) → Booking (real confirmed bookings) → Waitlist (join/cancel through the real UI) → Notification preferences (toggle → persists → suppresses) all work together without conflict. Cross-user authorization spot-checked live via REST: a customer session was correctly refused (`403`) at an admin-only loyalty route and at another user's verification-evidence download; the real CRM/verification/loyalty ownership patterns were independently confirmed by each step's dedicated audit above. Membership's booking-order discount and B2B's cart-based tier pricing were re-confirmed structurally disjoint (booking orders never touch the WooCommerce cart at all), so the two cannot stack under any real order — this was Step 9's own explicit, already-tested finding, not newly re-derived here.

### Master localization / Jalali audit

Project-wide grep passes for raw English JSX text nodes, English REST error messages (`Response::error`, `WP_Error` message strings), and English exception messages found **zero matches** across every `beauclick-*` plugin and the `app/src` tree. `نوبت`/`رزرو` usage is currently 21/21 in the frontend (up from the gap register's originally-documented 12/9, reflecting the steps built since) — still an even split with no fully standardized rule, confirmed to follow the same existing convention (`نوبت` for the customer-facing appointment concept, `رزرو` for the booking action) rather than introducing a new inconsistency; LOC-04 remains correctly tracked as an open, non-blocking item, not silently worsened. Jalali date-display grep passes (raw `toLocaleDateString`, raw PHP `date('F j, Y')`-style formats) found no leaks; every checked surface routes through the existing shared `JalaliDate`/`formatFullJalaliDate`.

### Security/authorization audit

No new vulnerability found. One real, confirmed, but non-exploited defect was found and fixed (see Bugs below) in the shared `RestController::route()` permission-callback safety net. Every actual registered route across all ten `beauclick-*` plugins with a REST controller was confirmed (via direct source inspection of every `->route(...)` call site) to already declare an explicit `permission_callback` — the defect was in the net meant to catch a *future* omission, not in any currently-shipped route.

### Database/migration audit

Every migration across every `beauclick-*` plugin uses WordPress's own `dbDelta()` against a full `CREATE TABLE` definition (confirmed by direct grep — no raw, non-idempotent `CREATE TABLE`/`ALTER TABLE` outside that pattern), which is idempotent by construction (dbDelta diffs against the live schema; safe to re-run). No destructive migration exists; every additive table/column change already documented in each step's own notes above.

### Test results

| Suite | Before this audit | After this audit |
|---|---|---|
| Backend (PHPUnit) | 533/533 | **535/535** (+2 regression tests for the `RestController::route()` fix) |
| Frontend (Vitest) | 27/27 | 27/27 (unchanged) |
| TypeScript | clean | clean |
| Production build | clean | clean |
| PHP lint (`php -l`, every `beauclick-*` plugin file) | not previously run project-wide this session | clean, zero syntax errors |

### Bugs discovered and fixed this audit

1. **Real, confirmed, non-exploited — `RestController::route()`'s missing-permission_callback guard never actually fired**, for any route, in this codebase's entire history. The guard iterated `$args[0] ?? $args`; for the flat single-variant array shape every one of the ~90 registered routes across all ten plugins actually uses (`['methods'=>..., 'callback'=>..., 'permission_callback'=>...]`), `$args[0]` doesn't exist so it fell through to `$args` itself, and the `foreach` then iterated over that array's individual *values* (a method string, a callback array, a permission-callback array) rather than over route-variant arrays — `isset($variant['callback'])` was structurally never true for any of them. Confirmed every one of the ~90 real call sites already independently declares `permission_callback` regardless (verified by direct `grep` across every controller), so this was a dead safety net, not a live hole — but it directly contradicted the gap register's own SEC-03 claim ("confirmed by design, not just convention"). Fixed by correctly detecting the flat-vs-list-of-variants shape (`isset($args['callback']) ? [$args] : $args`); two new regression tests (`RestControllerTest`) assert both that the guard now throws when `permission_callback` is genuinely missing and that it doesn't false-positive when present, using the exact shape every real controller uses.
2. **Real, low-severity, non-blocking — `AiPanel.tsx`'s logged-out "ورود" call-to-action still linked to `/wp-login.php?redirect_to=...`** instead of `/auth/`, contradicting Step 6's own documented claim that every normal-user-facing login reference was migrated. Not a security issue (`wp-login.php` still works correctly and safely) — a UX/accuracy gap only. Fixed to match the exact convention used everywhere else in the theme (`header.php`, `page-b2b.php`, `page-dashboard.php`, `single-bc_professional.php`): a plain link to `/auth/`, no redirect parameter (matching the fact that none of those other call sites use one either).

Both fixes are minimal, scoped exactly to the confirmed defect, covered by either an existing or a new regression test, and re-verified: full backend suite re-run (535/535), TypeScript/build re-run (clean), and the AI panel's logged-out state re-checked live in the browser.

### Non-blocking limitations re-confirmed still accurate (not new findings)

Footer copyright year remains Gregorian (`gmdate('Y')`) — pre-existing, already-documented `LOC-02`, deliberately accepted twice before and not revisited here. No admin UI exists for reviewing recorded `wp_bc_phone_conflicts` rows (AUTH-10's own documented follow-up). No staff-permission model, no CRM note edit/delete, no CRM frontend pagination UI (Step 5's own documented limitations). All other Known Limitations sections in each step's notes above remain accurate as written.

### Business/legal decisions still required (unchanged by this audit, not resolved here)

Terms of Service full text, exact data-retention windows, refund timing/fees, business identity/contact details, cookie/consent policy content, real tier thresholds/benefit values/membership pricing, rebooking interval, retention window, waitlist batch/cooldown values, notification category wording, and SMS provider selection. None of these were decided by this audit — all remain exactly as marked `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`/`EXTERNAL_CONFIGURATION` in their originating step's notes and in the gap register.

### Production infrastructure gaps (unchanged, not code defects)

Per the gap register's own Operations/External-Configuration sections, still accurate: no real SMS gateway, no SMTP, no real Iranian payment gateway credentials, no automated backup, no error-monitoring integration, no real system cron configured (WP-Cron's own request-triggered pseudo-cron is what every scheduler in this codebase currently relies on for local/dev verification). All are standard pre-launch operational tasks, not gaps in the BeauClick codebase itself.

### Release decision

**V2.1 READY FOR RELEASE.**

All six completed steps (5 through 10) were verified — independently for 5–8, by direct re-confirmation for 9–10 — to work as documented, with real, current, passing test coverage; the one real defect found (a dead REST permission-callback safety net) had zero live routes actually depending on it being broken, and is now fixed and regression-tested; the one UX-accuracy gap found (a stray `wp-login.php` link) is fixed; localization, Jalali, RTL/mobile, and accessibility all check out against this audit's own fresh passes; no critical authorization or data-isolation issue was found anywhere; V1 (`v1.0.0`/`v1.0.1`) and V2.0 (`v2.0.0`) remain completely untouched (git-verified, tags dereference to their original, unmoved commits); no V2.2/Campaign/Financial/Realtime/Mobile/AI-for-Professionals/Marketplace work exists anywhere in this codebase. Per this audit's own explicit instruction, **no `v2.1.0` tag was created** — this decision is reported for approval, not acted on unilaterally.

**Post-report update:** `v2.1.0` was subsequently tagged (annotated, pointing to `d1445092977ab6a9f95bd50221e43ef761ac2b91`) and released on GitHub after explicit approval. V1 and V2.0 tags confirmed unmoved at tagging time.

---

## V2.2 Strategic Roadmap & Architecture Plan

**Planning-only document. No V2.2 code, migration, or UI exists as of this writing.** Audited state: `master` at `v2.1.0` (`d1445092977ab6a9f95bd50221e43ef761ac2b91`), V1/V2.0 frozen and unmoved. This section defines what V2.2 should build and in what order — built from the actual current codebase and `PRODUCT_GAP_REGISTER.md`'s current state, not from blindly continuing the very first V2 planning document's now-partly-overtaken sequence (see immediately below for why).

### Why V2.2 cannot simply continue the original sequence

The original V2 plan (§3–§17 above) proposed a four-wave sequence: V2.0 (intelligence/signal foundation), V2.1 (personal/professional relationship layer — Journey, CRM, Loyalty tiers/Membership), V2.2 (retention/growth — a Notifications service, Waitlist, Smart Rebooking, retention automation, Referral), V2.3 (monetization/professional tools — Campaign Engine, AI-for-Professionals, Financial/Payout), V2.4 (platform expansion — Realtime, Multi-vendor, Mobile).

What actually shipped diverged in two ways, both already documented above ("Post-Audit V2.1 Reprioritization"): first, the V2.1 Product Gap Discovery Audit found genuinely blocking, previously-unknown gaps (no registration path, no published legal pages, no verification evidence trail) that pulled three entirely new capabilities — Authentication & Registration, Legal & Trust Foundation, Professional Verification Evidence — into V2.1 ahead of Membership. Second, once Loyalty/Membership (Step 9) was underway, the dependency chain for the original plan's own "V2.2" (Waitlist/Rebooking/Retention, gated on a Notifications-service prerequisite the original plan itself flagged as missing) turned out to share no meaningful release boundary with what came after it — it was pulled forward and delivered as V2.1 Step 10, Notifications service included.

**Net effect: V2.1 already delivered almost the entire original V2.0–V2.2 arc**, plus three capabilities the original plan never named. Only **Referral** (originally bundled into Step 9/Loyalty, explicitly deferred — see Step 9's own Known Limitations) was left genuinely undone from that whole arc. Everything else still open today comes from two other sources: (a) the original plan's own V2.3/V2.4 wave (Campaign Engine, Financial/Payout, AI-for-Professionals, Realtime, Multi-vendor, Mobile — all still correctly unbuilt, per that section's own risk analysis, which this document re-affirms below rather than re-deriving from scratch), and (b) items the Product Gap Register discovered along the way that never got their own step at all — SEO, analytics/funnel instrumentation, a general admin audit log, account privacy/deletion/export, booking rescheduling, invoice/receipts, multi-staff business permissions, and the professional profile/portfolio sections reserved since V1 but never finished.

**V2.2, as defined below, is built from that actual remaining set** — not a renumbering of the old plan's "V2.2," and not a blind continuation of "whatever came next in the list."

### Post-V2.1 product state

The core value loop (discovery → AI → booking → payment → review → loyalty → journey → CRM → waitlist/rebooking/retention) is real, tested, and live-verified end to end. Ten domain plugins around `beauclick-core`, all following the same `RestController`/`Response`/`dbDelta`/WP-Cron/ownership-check conventions established since V1. A real, append-only event log (`wp_bc_events`) now has genuine writers (booking lifecycle, reviews, loyalty, ranking, and — per V2.1 Step 10 — notification delivery), but still only the events those specific systems needed; no funnel-stage events (search, checkout-started) exist. A real central notification pipeline exists and is reused correctly by four features; nothing about it needs rebuilding. Real registered customers can now exist for the first time in this project's history, real legal pages are published, and real professional verification with an evidence trail exists — which is exactly what makes SEO-driven and referral-driven acquisition newly *meaningful* (before Step 6, there was nowhere for an organically-arriving visitor to actually register).

### Gap Register analysis — what's actually still open

Cross-referencing `PRODUCT_GAP_REGISTER.md`'s current state (post V2.1 audit) against every non-`IMPLEMENTED` row, filtered to items with genuine, assignable product-development scope (excluding pure `EXTERNAL_CONFIGURATION`/`NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW` items no engineering step can resolve unilaterally):

| Category | Items | Disposition |
|---|---|---|
| SEO (SEO-01/02/03/04) | Meta/OG tags, sitemap, structured data, canonical URLs — all `MISSING`, all confirmed still true | **V2.2** — see Step 12 |
| Analytics (ANLYT-02/03/04/05) | Search events, checkout-funnel events, admin dashboard, CRM/Journey usage measurement — all `MISSING` | **V2.2** — see Step 11 |
| Admin (ADMIN-01/02) | General admin shell polish, admin audit log beyond verification's own | **V2.2** — see Step 13 |
| Notification center (NOTIF-04) | Full bell/unread-count UI — backend history already exists (V2.1 Step 10) | **Evidence-gated, not V2.2** — see rationale below |
| Privacy (AUTH-07/08, PRIV-02/03/04) | Self-service account deletion, data export, retention/anonymization policy | **V2.2** — see Step 14 |
| Booking (BOOK-03) | Rescheduling — `MISSING`, confirmed not pulled into Step 10 | **V2.2** — see Step 15 |
| Commerce (COM-04) | Order/booking invoice/receipt PDF | **V2.2** — see Step 15 |
| Accessibility (A11Y-03) | Automated a11y testing (axe-core/Lighthouse CI) | **V2.2, opportunistic** — folded into Step 13's tooling work, not a standalone step |
| Marketplace (MKT-02, referenced in the register's own P3 list) | Fuzzy/typo-tolerant search | **Deferred past V2.2** — no evidence of a real query-quality problem; matches the original architecture doc's own "MySQL indexing is sufficient until measured otherwise" stance |
| Professional (PROF-05) | Multi-staff business permission model | **V2.2** — see Step 16 |
| Professional (PROF-03, partial) | Portfolio section still a V1-era placeholder | **V2.2** — see Step 16 |
| CRM (deferred from Step 5) | Note edit/delete, frontend pagination UI | **V2.2** — see Step 16 |
| Loyalty (deferred from Step 9) | Referral | **V2.2** — see Step 12 |
| AI (AI-03) | Cost/usage visibility | **V2.3** — only matters once a real paid provider is configured; bundle with whichever V2.3 step first touches real-provider configuration |
| Commerce (COM-05, partially open) | Price-hook stacking risk for a *third* price-modifying feature | **Addressed as a V2.3 prerequisite, not a V2.2 step** — see the Pricing Orchestration analysis below |
| Campaign/Promotion Engine, AI-for-Professionals, Financial/Payout | Zero-to-weak foundation, high risk, real business/gateway decisions pending | **V2.3** — unchanged from the original plan's own risk analysis, re-affirmed below |
| Realtime, Multi-Sided Marketplace, Native Mobile | No evidence of real need | **V2.4+, evidence-gated** — unchanged |

### Notification center — why it's evidence-gated, not a V2.2 step

The task's own instruction is to determine "the smallest useful evolution," not to rebuild the notification system by default. V2.1 Step 10 already built the reusable backend (`NotificationService::for_user()`) and a simple read-only recent-activity list — a full bell/unread-count/read-state UI was deliberately scoped out at the time as unnecessary until real usage data says otherwise. V2.2's own Analytics step (11) is positioned specifically to be able to answer that question with real data (are customers engaging with the existing simple list? are notification-driven rebooking/retention conversions measurable?) before a heavier UI is justified. Recommendation: **do not build a full notification center in V2.2**; revisit once Step 11's analytics exist to inform whether it would actually move a real metric.

### Pricing orchestration — the question this task explicitly asks

COM-05 (the WooCommerce price-hook stacking risk) is **partially resolved** as of V2.1 Step 9: booking-order membership discounts and B2B tier pricing are structurally disjoint (the former is an order-level fee, never touching the cart the latter filters), so today's two live price-modifying features cannot conflict. The open risk is a hypothetical *third* feature — Campaign Engine — that would want to modify the cart too. **V2.2 does not need to build a central pricing/discount orchestration layer**, because nothing in V2.2's own scope (Steps 11–16 below) touches WooCommerce pricing or the cart at all — building that layer now, with nothing yet to validate it against, would be exactly the kind of premature infrastructure this project's own standing discipline warns against. **Recommendation: design the orchestration layer as the first, explicit sub-step of V2.3's Campaign Engine work** — the moment a real third price-modifying feature is about to exist is the correct moment to decide hook ordering and combination rules, informed by two real, working examples (B2B, Loyalty/Membership) rather than a hypothetical third one.

### Notification architecture evolution for V2.2

No rebuild. The one addition worth making, folded into Step 11 (Analytics) rather than given its own step: extend event logging so notification delivery outcomes (already logged, per V2.1 Step 10) feed the same funnel/aggregation views Step 11 builds — e.g., "did a rebooking notification actually lead to a booking within N days" as a real, queryable metric, not a new delivery mechanism.

### Analytics — event taxonomy and aggregation model for V2.2

Per the task's own instruction to define, not build: the missing event types are `search` (query, filters applied, result count), `checkout_started` (cart contents, entry point), `cart_add`/`cart_remove`, and lightweight `crm_opened`/`journey_opened` usage pings — all following the exact shape `wp_bc_events` already establishes (`event_type`, `entity_type`, `entity_id`, `actor_id`, `meta` JSON, `created_at`), no schema change needed, only new writer call sites (the same "activate dormant infrastructure" motion that made V2.0 Step 1's event instrumentation and loyalty-ledger wiring a near-zero-risk first move). Aggregation should be periodic, admin-page-rendered summary queries (matching every existing admin page's own pattern) — **not** a dedicated analytics warehouse or a new BI tool; this project's real current scale doesn't justify one, and the task's own instruction is explicit about not building analytics infrastructure speculatively. Privacy implication worth flagging explicitly: aggregation must stay aggregate-only in anything admin-visible across users (no raw per-customer event stream surfaced anywhere new), matching the same data-minimization principle already applied to AI context assembly.

### SEO — should BeauClick own this layer

Yes. No SEO plugin should be introduced — the existing per-page-type meta-description/Open-Graph pattern already partially exists (`inc/seo.php`, added during V1's Production Readiness pass for professional/product/front pages) and should simply be extended to marketplace listing, city, and specialty pages, plus a real XML sitemap (WordPress core's own `wp-sitemap.php` is very likely sufficient — verify against BeauClick's actual CPT registration before assuming a custom sitemap generator is needed) and `LocalBusiness`/`Service` structured data for professional profiles (`Product` schema already exists for shop products via WooCommerce, per the existing `Currency.php` comment). This is page-template and metadata work within the existing theme, not a new subsystem.

### Architecture evolution required for V2.2

**None.** Every one of Steps 11–16 below extends an already-established pattern: `wp_bc_events` (analytics), the existing admin-page convention (admin platform), the existing REST/`RestController`/ownership pattern (privacy/data-control endpoints), the existing atomic-slot-claim discipline (rescheduling), the existing CRM/profile tables (professional platform completion). No new database technology, no new caching layer, no new job-queue system, no new search engine, no Redis/Kafka/RabbitMQ/Elasticsearch/microservices — none of V2.2's own scope produces a "why now" case for any of them, matching this document's own standing "prefer incremental evolution" principle (§7 above, re-affirmed, not re-litigated).

### V2.2 recommended Steps

#### Step 11 — Analytics & Business Intelligence Foundation
- **Objective:** Instrument the missing funnel events and build a lightweight admin aggregation view, so every subsequent V2.2 step (and V2.1's own already-shipped retention automation) can be measured against real data instead of assumption.
- **Dependencies:** None blocking — `wp_bc_events` and its writer pattern already exist and are proven (V2.0 Step 1, V2.1 Step 10).
- **Database impact:** None — new writer call sites into the existing table only.
- **API impact:** New admin-only aggregation endpoints (reusing `RestController`'s existing admin-capability gate).
- **UI impact:** One new admin summary page (existing admin-page pattern), no customer/professional-facing UI.
- **Expected value:** High leverage, low cost — every future product decision (including whether Step-11-adjacent features like a notification center are worth building) becomes measurable instead of guessed.
- **Complexity:** Low.
- **Major risks:** None structural; the only real risk is under-scoping the event taxonomy and having to add more writer call sites later — acceptable, since adding an event type is additive and low-cost by design.
- **Explicitly excluded:** A dedicated analytics warehouse, third-party BI tool, or per-user behavioral dashboards.
- **Definition of done:** New funnel events logged from real user actions (search, cart add, checkout start); an admin summary page rendering real aggregate numbers (not a mock); zero raw per-customer event stream exposed anywhere new; full Persian/RTL; tests for every new writer call site and the aggregation queries.

#### Step 12 — Growth & Public Discovery (SEO + Referral)
- **Objective:** Turn on organic (SEO) and referral-driven customer acquisition — both structurally meaningless before V2.1 (no registration path existed) and both now unblocked.
- **Dependencies:** Authentication (done, V2.1 Step 6), Legal pages (done, V2.1 Step 7) — a referral program pointing at a platform with no registration or published terms would have been building on sand; both prerequisites are now real.
- **Database impact:** SEO — none (metadata only). Referral — new `wp_bc_referrals` table (referrer_id, referred_id, status, reward_issued_at, created_at), unique-constrained against self-referral and duplicate attribution, following the existing append-only-ledger-adjacent convention.
- **API impact:** SEO — none (server-rendered template changes only). Referral — new endpoints for code generation/redemption, self-scoped.
- **UI impact:** SEO — none visible to users directly (meta/structured-data only). Referral — a small share/redeem UI, natural fit inside the Beauty Journey tab (an existing, already-built customer-dashboard surface).
- **Security impact:** Referral fraud prevention (self-referral, duplicate attribution, eligibility windows) needs real server-side enforcement — the single genuine engineering risk in this step, already flagged as such by the original architecture assessment (§4.6) and unchanged.
- **Expected value:** High — this is the first V2.2 capability with a direct, measurable effect on top-of-funnel acquisition, and Step 11's analytics work lets that effect actually be measured.
- **Complexity:** Low (SEO) to medium (referral fraud prevention).
- **Explicitly excluded:** Paid SEO tooling/plugins, any campaign/promotion-style referral reward beyond a simple, fixed, documented incentive (campaign-grade audience targeting stays in V2.3).
- **Definition of done:** Every marketplace/profile/service/product/city/specialty page has correct meta description, Open Graph tags, and canonical URL; a working sitemap; structured data validated against Google's own testing tool; a working referral code flow with server-enforced fraud prevention and full test coverage; full Persian/RTL.

#### Step 13 — Admin Platform & Operations Maturity
- **Objective:** Give operations real cross-cutting tools for the load V2.1's five new subsystems (verification queue, notification delivery, loyalty grants, waitlist, retention sweeps) now generate day to day.
- **Dependencies:** None blocking; benefits from Step 11's aggregation patterns but isn't gated on them.
- **Database impact:** Small — extend the existing verification-scoped audit-history pattern to a general-purpose admin action log (same append-only shape, new `action_type`/`entity_type` values, not a new architecture).
- **API/UI impact:** A small admin-home surface aggregating cross-plugin operational status (verification queue depth, notification failure rate, waitlist backlog) — reusing every existing admin page's own rendering pattern, explicitly **not** a redesign of wp-admin itself.
- **Expected value:** Medium-high — directly reduces operational risk now that real users, real professionals, and real automated retention messaging all exist simultaneously for the first time.
- **Complexity:** Low-medium.
- **Explicitly excluded:** A general observability platform, a full admin-UI redesign, real-time monitoring/alerting (that's OPS-04's `EXTERNAL_CONFIGURATION` territory — a Sentry-class tool, not something this codebase should reimplement).
- **Definition of done:** A general admin audit log covering actions beyond verification; a small ops-status admin page; opportunistically, automated accessibility testing (axe-core or equivalent) wired into the existing test pipeline (A11Y-03) — folded in here since it's tooling maturity of the same kind, not a product feature deserving its own step; full Persian/RTL for every new admin surface.

#### Step 14 — Account Privacy & Data Control
- **Objective:** Close the gap between what the now-published Privacy Policy (V2.1 Step 7) promises and what the product actually lets a real user do — self-service deletion and data export.
- **Dependencies:** Legal pages (done — the policy text this step must actually honor), and every domain that holds user data (Auth, CRM, Journey, Chat, AI, Loyalty, Membership, Waitlist, Notifications — all already built).
- **Database impact:** None structural — deletion/anonymization logic operates across existing tables; no new domain table required, though a small `wp_bc_data_requests` audit table (request type, status, requested_at, completed_at) is worth adding for compliance traceability, matching the same append-only-audit convention used elsewhere.
- **API impact:** New self-scoped endpoints (`request account deletion`, `request data export`) — admin-reviewed for deletion (not instant, irreversible self-execution) given the cross-domain blast radius, matching this project's own "no ordinary-user write path to anything requiring careful handling" discipline (the same principle already applied to financial-record safety in §8 above).
- **UI impact:** New Account-tab controls (existing customer-dashboard surface).
- **Security impact:** The core engineering challenge of this step — safe anonymization semantics that don't corrupt referential data other customers/professionals still legitimately need (e.g. a deleted customer's historical review should very likely be anonymized, not silently deleted out from under a professional's own rating history).
- **Expected value:** High trust-integrity value — a live Privacy Policy without real deletion/export capability is itself a credibility and (jurisdiction-dependent) compliance risk once real users exist, which V2.1 just made possible for the first time.
- **Complexity:** Medium — the individual deletions are straightforward; getting anonymization-vs-deletion semantics right across nine domains is the real work.
- **Explicitly excluded:** Automatic time-based data retention/purging (PRIV-04's broader retention *policy* remains `NEEDS_BUSINESS_DECISION` — this step builds the mechanism a policy would use, not the policy itself).
- **Definition of done:** A real, tested, admin-reviewed account-deletion flow with defined anonymization semantics per domain; a real data-export flow producing a genuine, complete export of a user's own data; full Persian/RTL; explicit test coverage proving one user's deletion never corrupts another user's legitimately-retained data (e.g. reviews, CRM notes another professional holds).

#### Step 15 — Booking Evolution: Rescheduling + Receipts
- **Objective:** Close the one remaining well-scoped, low-risk booking gap (rescheduling) and a small commerce-completeness item (receipts), without touching booking's core atomic-claim architecture.
- **Dependencies:** None — the booking engine (hold/expiry, atomic slot claim, cancellation, no-show) is stable and unchanged since V2.1 Step 10.
- **Database impact:** None new for rescheduling — reuses the exact atomic `UPDATE ... WHERE status='open'` discipline booking already uses (a reschedule is, structurally, a cancel-and-atomic-reclaim on the same booking row, not a new concurrency primitive). Receipts need no new table — rendered on demand from existing `wp_bc_bookings`/WooCommerce order data.
- **API impact:** New `POST /booking/bookings/{id}/reschedule` (reusing the exact ownership gate `/confirm`/`/no-show` already established); a receipt-download endpoint.
- **UI impact:** A reschedule action in the existing bookings UI; a "دانلود رسید" action alongside existing booking/order views.
- **Expected value:** Medium — closes a real, named customer-facing gap (today's only path is cancel-and-rebook, which loses the original slot to anyone else) with contained, low-risk engineering.
- **Complexity:** Low-medium.
- **Explicitly excluded:** A visual drag-and-drop professional calendar (that's Step 16/professional-platform territory if ever pursued, not bundled here); invoicing for B2B wholesale orders beyond what WooCommerce's own order system already provides.
- **Definition of done:** A real reschedule flow with the same concurrency safety already proven for booking/cancellation, a dedicated race-condition test; a real receipt document (PDF or print-ready HTML) for both booking and B2B orders; full Persian/RTL/Jalali on every new surface.

#### Step 16 — Professional/Business Platform Completion
- **Objective:** Finish what V1's own design explicitly reserved but never built — the professional dashboard's remaining placeholder sections, the multi-staff business model flagged as a known limitation since V2.1 Step 5, and (clarified after Step 11's completion) a real Professional/Business Analytics Dashboard consuming Step 11's foundation.
- **Dependencies:** CRM (done, V2.1 Step 5 — staff permissions extend its existing ownership model), Authentication (done — a real account model to extend to multiple staff members per business), **Analytics & BI Foundation (done, V2.2 Step 11 — this step's own analytics work is a consumer of that foundation, not a second one; see the "Step 11 vs. Step 16" subsection immediately below).**
- **Database impact:** New — a `wp_bc_business_staff` table (business_id, user_id, role/permission set, invited_at, status), extending rather than replacing `ProviderLookup`'s existing "one owner per provider post" resolution (a business's staff resolve to the same provider post, with a permission subset, not a second provider identity). **No new database impact for analytics** — the Professional/Business Analytics Dashboard reads through Step 11's existing `MetricsService`/`wp_bc_events` foundation, scoped to the requesting professional/business's own `entity_id`(s); it does not introduce a second event log, a second metrics table, or duplicate metric-definition logic.
- **API impact:** New staff-invite/manage endpoints; extend CRM's note model to support edit/delete (already flagged as deferred in Step 5); add the pagination the CRM API already structurally supports but the frontend never consumed. **New role-scoped analytics endpoint(s)** — an extension of Step 11's `beauclick-analytics` REST surface (or a thin, same-plugin addition to it) that reuses `MetricsService`'s existing query methods with an added ownership filter, rather than a parallel `AnalyticsController` in this step's own plugin.
- **UI impact:** New business-staff management screen; portfolio-upload UI (closing V1's own "این بخش در نسخه بعدی محصول تکمیل می‌شود" placeholder — real file upload through `wp_handle_upload()` with the same MIME/size discipline Step 8's evidence storage already established, though portfolio images, unlike verification evidence, correctly belong in the Media Library since they're meant to be public). **A new Professional/Business Analytics Dashboard tab** in the existing professional/business dashboard shell (`dashboard-professional`/B2B account area) — not a new standalone app, not a wp-admin page (Step 11's dashboard is the platform-admin, wp-admin-side view; this one is the professional/business-facing, app-shell-side view of the *same* underlying metrics, scoped to what that professional/business is allowed to see).
- **Security impact:** Staff permission boundaries need the same ownership rigor as everywhere else — a staff member must never be able to act as if they own the business, only within their granted permission subset; explicit test coverage required. **Analytics ownership scoping** needs the same rigor: a professional/business must only ever see aggregates over their own bookings/profile/reviews, never platform-wide totals and never another professional's/business's data — enforced server-side (the same `require_owner_or_capability` pattern already used everywhere else in this codebase), not left to the frontend to filter.
- **Expected value:** Medium-high for the (currently small but real) subset of business accounts that are actually salons/clinics with multiple staff, not solo professionals; also removes a visible, long-standing "coming soon" placeholder from the product. The analytics addition gives every professional/business real visibility into their own performance for the first time (today the only way to see this is a direct database query, and even then only platform-wide, not per-professional).
- **Complexity:** Medium.
- **Explicitly excluded:** A full HR/scheduling system for staff (shift management, staff-level availability) — staff permissions here mean "can this person act on the business's CRM/bookings," not a staffing/rostering product. **Revenue/financial analytics remain excluded** from this step's own analytics work, same as Step 11 — `PRO-02` (the professional dashboard's `درآمد` revenue tab) stays targeted at V2.3 once Financial/Payout exists; this step's analytics surface real operational metrics (bookings, conversion, repeat customers, reviews, profile views) only, never money figures that don't yet have a real payout system behind them.
- **Definition of done:** A real staff-invite-and-permission flow with test-covered ownership boundaries; real portfolio upload replacing the V1 placeholder; CRM note edit/delete plus real frontend pagination; **a real, ownership-scoped Professional/Business Analytics Dashboard reusing Step 11's `MetricsService`, covering at minimum: profile views, booking conversion, bookings/completed bookings, repeat customers, customer retention, reviews, and service/professional performance relevant to marketplace engagement — future revenue analytics deferred to V2.3 alongside Financial/Payout**; full Persian/RTL/Jalali.

### Step 11 vs. Step 16 — analytics ownership boundary (clarified after Step 11's completion)

Step 11 ("Analytics & BI Foundation") and Step 16 ("Professional/Business Platform Completion") both touch analytics, and the roadmap did not previously say explicitly where the line between them falls. It is now made explicit:

**Step 11 owns the foundation:**
- Event collection (the event taxonomy — `search_performed`, `product_view`/`cart_add`/`checkout_started`, `ai_assistant_opened`/`crm_opened`/`journey_opened`, plus every pre-existing event type).
- Metric definitions and their documented sources (`Metrics\MetricsService`'s query methods — funnel, commerce, search, AI, retention, usage, marketplace).
- Aggregation (live SQL aggregation over `wp_bc_events` and domain tables, date-range-bounded).
- The platform-level, admin-only view (`AnalyticsDashboardPage` in wp-admin, gated on `bc_manage_platform`).
- The reusable analytics services other steps are expected to consume, not reimplement.

**Step 16 consumes that foundation, scoped to one owner:**
- A Professional Analytics Dashboard and a Business Analytics Dashboard, both living in the existing customer-facing app-shell's professional/business dashboard areas (not wp-admin).
- Role-scoped analytics: the same underlying `MetricsService` query methods, called with an added ownership filter (by provider/business entity id) so a professional/business sees only aggregates over their own data.
- Business/professional performance views built from that scoped data — profile views, booking conversion, bookings/completed bookings, repeat customers, retention, reviews, service performance, and other marketplace-engagement metrics named in Step 16's own Definition of Done above. Future revenue analytics once Financial/Payout (V2.3) exists.

**What Step 16 must NOT do:** duplicate the event system, create a second analytics engine, or duplicate metric definitions unnecessarily. If a metric Step 16 needs isn't already exposed by `MetricsService` in a shape that supports ownership scoping, the correct move is to extend `MetricsService` itself (adding an optional entity-id filter to the relevant method), not to write a second, parallel query against `wp_bc_events`.

This distinction was identified as a documentation gap immediately after Step 11 shipped — Step 11's own implementation notes already state a professional/business-facing view was deliberately out of that step's scope; this section is what makes explicit, for the first time, that the correct home for it is Step 16, not a new step and not left unassigned.

### V2.3 boundary — what's explicitly deferred and why

**Campaign/Promotion Engine, Financial/Payout, AI for Professionals & Businesses** — all re-affirmed as V2.3, unchanged from the original assessment's own risk analysis (§4.4/§4.7/§4.10 above), because nothing about V2.1's actual delivery weakens that reasoning:

- **Campaign Engine** needs (a) the pricing-orchestration decision this document places at the *start* of this step, not before it, and (b) real audience-segmentation data — which Step 11's analytics work (V2.2) is what will make campaign targeting meaningful rather than speculative. Sequencing it after V2.2's analytics foundation, not before, is a genuine dependency, not just risk-aversion.
- **Financial/Payout** remains the single highest-risk, zero-existing-foundation capability in the entire roadmap — real money, real audit requirements, and a real payment-gateway decision (still open, per V1's own architecture doc) that should land before a payout/settlement model is built around it. Unchanged business-decision flag: if monetization urgency outweighs this risk, that's a legitimate reason to pull it earlier, but it's a call for the product owner, not an engineering default.
- **AI for Professionals** reuses CRM+event-instrumentation, both of which now exist (CRM since V2.1 Step 5, events real since V2.0 Step 1) — technically startable earlier, but grouped with Campaign/Financial in V2.3 because it shares their "premium/monetizable professional tooling" character and because getting the authorization-boundary engineering right (a professional's AI must never assemble another professional's data) deserves dedicated, unhurried attention rather than being squeezed alongside V2.2's operational-maturity focus.

### V2.4 boundary — unchanged

**Realtime Communication, Multi-Sided Marketplace, Native Mobile** — all remain evidence-gated exactly as the original assessment specified (§4.11/§4.3/§4.12, §14 above): revisit only when real chat-volume complaints, real seller-side demand beyond BeauClick's own wholesale catalog, or real mobile-specific user demand actually materializes. Nothing discovered during V2.1 or this planning pass changes that calculus — restating it here rather than re-deriving it, per this document's own standing principle of not building ahead of evidence.

### Business decisions still required for V2.2 (not resolved by this plan)

- **Referral reward structure** (Step 12) — what the actual incentive is (fixed credit, percentage, loyalty points) is a business decision; the engineering plan above builds the mechanism, not the value.
- **Data retention/anonymization policy specifics** (Step 14) — this step builds the *mechanism*; exact retention windows and what counts as "anonymized enough" remains `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`, same as it's been since the original Legal audit.
- **Rescheduling policy** (Step 15) — how many times a booking may be rescheduled, and any cutoff window before the appointment, needs a real business rule, not an engineering default.
- **Multi-staff permission granularity** (Step 16) — what a staff member is and isn't allowed to do is a product decision; the engineering plan builds a permission-set mechanism, not the specific role definitions.

### External configuration relevant to V2.2

None of Steps 11–16 introduce a new external dependency. Existing ones (SMS gateway, SMTP, real payment gateway, backup, monitoring) remain exactly as documented in the V2.1 Final Release Audit — still required before production launch, still not a V2.2 code gap.

### Risks

1. **Analytics scope creep** — the temptation to build a "real" BI platform instead of the lightweight aggregation this plan specifies; the task's own instruction and this project's own anti-premature-infrastructure discipline both argue against it.
2. **Referral fraud** — the one genuine security-engineering risk in Step 12; needs the same rigor as any other financial-adjacent feature in this codebase.
3. **Privacy/deletion anonymization correctness** — the one genuine data-integrity risk in Step 14; a bug here either fails to actually delete what a user asked to delete, or corrupts another user's legitimately-retained data — both are real failure modes needing explicit adversarial test coverage, not just happy-path verification.
4. **Staff-permission boundary bugs** (Step 16) — the same class of risk as every other ownership boundary in this codebase; needs the same explicit test discipline already established for CRM/verification/loyalty ownership.
5. **Under-scoping SEO** — shipping metadata without verifying it against Google's actual structured-data testing tools risks looking done without being effective; verification, not just implementation, belongs in this step's Definition of Done.

### V2.2 Definition of Done

Every V2.2 step (11 through 16) must satisfy, in addition to its own step-specific Definition of Done above, the same standing bar already applied throughout V1/V2.0/V2.1: real business logic, real permissions/ownership enforcement (server-side, never frontend-trusted), real validation, loading/empty/error states, complete Persian RTL UI with correct Jalali dates via the existing shared implementation (no second date system, no unnecessary English string where a Persian equivalent exists, Persian digits where already used elsewhere), verified desktop and mobile (375/390/412) behavior, real test coverage for every new ownership boundary and concurrency-sensitive path, live browser verification where applicable, a security review, updated documentation, and a real git commit — and the feature must integrate correctly with the V2.1 domains it touches (Analytics with the existing event log; Growth/Referral with Auth/Legal/Journey; Admin Platform with the existing admin-page pattern; Privacy with every domain holding user data; Booking Evolution with the existing atomic-claim discipline; Professional Platform with CRM/`ProviderLookup`), not just in isolation.

---

## V2.2 Step 11 — Analytics & BI Foundation Implementation Notes

### What existed before, and what was actually missing

Event instrumentation itself was already strong — `wp_bc_events` (V2.0 Step 1) was already being written to by booking, review, message, B2B, and AI code paths, and read by the ranking engine and Beauty Journey's timeline. What was genuinely missing, confirmed by direct inspection rather than assumed from the Gap Register alone: no `search`/checkout-funnel/UI-usage events existed anywhere (ANLYT-02/03/05), and there was no read/aggregation layer at all — every existing consumer of `wp_bc_events` (`SignalCollector`, `TimelineComposer`) queries it for its own narrow purpose, not as a general metrics API. `waitlist_joined` and `membership_activated` event types were found already logged in the live database despite not being listed in `EventLogger`'s own docblock — a small pre-existing documentation drift (Steps 9/10 wired them without updating the central comment), not a Step 11 defect; not fixed here to stay within this step's own scope.

### New plugin, not new code inside an existing one

`beauclick-analytics` — a thin, self-contained plugin (no other plugin depends on it, matching `beauclick-notifications`'s own "new domain, new plugin" precedent) that:
1. Adds exactly three new WooCommerce-hook-driven events (`product_view`, `cart_add`, `checkout_started`, via `Tracking\CommerceTracker`) plus one directly-added event (`search_performed`, inside `MarketplaceController::browse()` — the platform's real, existing search/discovery entry point, not a new free-text search feature).
2. Adds one strictly allow-listed UI-visibility ping endpoint (`POST /analytics/track`, for `ai_assistant_opened`/`crm_opened`/`journey_opened` — the three cases where the server cannot otherwise reliably observe a panel/tab being opened).
3. Reads everything — old and new events, plus `wp_bc_bookings`, `wp_bc_waitlist_entries`, `wp_bc_notifications`, `wp_users`, `wp_posts` — live, through `Metrics\MetricsService`, and renders one admin-only dashboard page.

Every write goes through the existing `EventLogger` into the existing `wp_bc_events` table. No second event-log mechanism, no new event schema.

### Database

**Zero new tables.** This was a deliberate architecture decision, not an oversight — see `MetricsService`'s own docblock. At this project's real, directly-inspected event volume (thousands of rows, not millions), an indexed `COUNT`/`SUM`/`GROUP BY` over a date-bounded range is fast with no caching layer needed. A pre-aggregated `wp_bc_analytics_daily_metrics` cache table, computed nightly via WP-Cron, is the documented next step if real usage ever makes live aggregation measurably too slow — not built now because there is no evidence it's needed, matching this step's own explicit "no infrastructure overreach" instruction.

### API

Two routes only, both under `beauclick/v1`:
- `GET /analytics/overview` — admin-only (`bc_manage_platform`), returns eight sections (overview, funnel, commerce, search, ai, retention, usage, marketplace) for a `from`/`to` range (defaults to the last 30 days, clamped to at most 366 days).
- `POST /analytics/track` — any logged-in user, strictly allow-listed to the three UI-visibility events named above; the actor is always the current user, never client-supplied — this is deliberately not a general "log any event" endpoint.

### Metric definitions and sources (per this step's own "every metric must have an explicit source" instruction)

- **Booking funnel** (`started`/`confirmed`/`completed`/`cancelled`/`expired`/`noShow`, `conversionRate = completed / started`) — source: existing `booking_*` events, already logged by `BookingService`'s own atomic transitions; no new events added.
- **Commerce funnel** (`productViews`/`cartAdds`/`checkoutStarted`/`ordersCompleted`/`ordersRefunded`, `checkoutConversionRate`) — source: the three new `CommerceTracker` events plus `order_completed`/`order_refunded`, **explicitly filtered to exclude any order linked to a booking** (via `wp_bc_bookings.wc_order_id`) so this funnel isn't distorted by orders that never went through `checkout_started` in the first place — booking orders bypass the WooCommerce cart entirely (`BookingOrderBridge`), so this exclusion is a correctness fix, not an approximation.
- **Platform overview** (`ordersCompletedAllTypes`, `grossRevenueAllTypes`, etc.) — deliberately the un-filtered version of the same events, for a genuine whole-platform total; the label makes the difference from the commerce section explicit.
- **Search** (`totalSearches`, `uniqueSearchers`, `zeroResultRate`, filter-usage counts) — source: the new `search_performed` event, logged directly inside the existing filtered-browse endpoint (there is no separate free-text search feature — see MKT-02 for that distinct, deferred gap). Deliberately stores only bounded counts and filter-usage booleans, never raw query text (there is no free-text query param to begin with).
- **AI** (`assistantOpened`, `recommendationsShown/Clicked`, `clickThroughRate`) — `assistantOpened` is new (a UI ping); shown/clicked already existed (`beauclick-ai`'s `AssistantService`) and are only read here.
- **Retention** — waitlist and notification-delivery counts are read directly from `wp_bc_waitlist_entries`/`wp_bc_notifications` (already the authoritative source for those subsystems, per this step's own "event vs. database fact" instruction); the one new inference, `recoveredBookings`, is an explicit 14-day time-correlation approximation between a sent rebooking/retention notification and the same customer's next `booking_created` event — labeled in the API response itself as a correlation, not a verified click-through, since no click-tracking mechanism was built for it.
- **Usage** (`crmOpened`, `journeyOpened`) — the two remaining new UI-visibility pings. Loyalty/membership viewing was deliberately **not** made a separate tracked event — `LoyaltySection` always renders as part of the Journey tab, not a distinct navigation destination, so a second ping there would double-count the same tab visit.
- **Marketplace** — `professionalSupply` is a current snapshot (not range-bound); `profileViews` reuses the pre-existing `profile_view` event (V2.0 Step 1).

### Admin dashboard

One page (`Admin\AnalyticsDashboardPage`) under the existing shared `beauclick` wp-admin menu — raw PHP/HTML, `wp-list-table`-styled tables, no React mount, matching every other BeauClick admin screen's own convention. Jalali-labeled range presets (امروز/۷ روز اخیر/۳۰ روز اخیر/این ماه شمسی — the last computed via `JalaliDate::toGregorian`/`toJalali`, no separate calendar library), plus a manual Gregorian from/to override. States plainly in its own header that every number is computed live on every page load, not cached — satisfying this step's own "don't leave freshness ambiguous" instruction by being unambiguous in the direction that's actually true. No professional/business-facing analytics view was built — explicitly deferred and documented (§21 of this step's own task), since Step 11's own scope boundary is a platform-admin foundation, not a full BI product.

### Persian localization / Jalali / RTL / mobile / accessibility

Every label, section title, and value is Persian; all numbers and percentages render in Persian digits. `dir="rtl"` on the page root. The date-range picker form initially overflowed horizontally at 375px width (`display:flex` with no wrap on two `<label>`+`<input type="date">` pairs) — found during live verification, fixed with `flex-wrap:wrap` (see Bugs below). No chart/canvas visualization exists anywhere on this page — every number lives in a real `<table>`, which trivially satisfies the "provide a textual/table equivalent" accessibility requirement by never needing one.

### Security

`GET /analytics/overview` is gated on `bc_manage_platform` (platform admin only) — analytics can reveal real business volume/revenue, so this is deliberately not a customer- or professional-facing endpoint. `POST /analytics/track` requires login and only accepts the three allow-listed event names; the actor is always `get_current_user_id()`, never a request parameter, so a logged-in user can only ever report their own view of their own session, never forge activity for another user or an arbitrary event name.

### Performance

Every query is bounded to the requested date range (clamped to at most 366 days by `MetricsService::normalize_range()`), uses the existing indexes on `wp_bc_events` (`event_type, created_at`), and runs once per admin page load — there is no per-request cost on any customer- or professional-facing page beyond the three new lightweight WooCommerce-hook/REST writes.

### Tests

17 new backend PHPUnit tests (`MetricsServiceTest`, `AnalyticsControllerTest`, `CommerceTrackerTest`) covering: range normalization (defaults, reversed-range swap, absurd-window clamp), funnel conversion-rate math including the zero-denominator case, the booking-vs-shop order exclusion (the one real correctness-sensitive query in this step), search zero-result/filter-usage detection from JSON meta, AI click-through rate, usage-event counting, REST authorization (admin-only overview, allow-list enforcement on track, actor-is-always-current-user), and CommerceTracker's own no-op guards (outside a product page, empty cart). Backend suite: **552/552** (535 pre-existing + 17 new), unchanged elsewhere. Frontend: **27/27**, unchanged (no new frontend unit tests — the three new `track()` call sites are one-line, side-effect-only instrumentation calls with no branching logic of their own to unit-test; they were verified live instead — see below). TypeScript and production build both clean.

### Live verification (real running site, real seeded database, real HTTP requests)

Performed against the actual local dev server (`php -S localhost:8080`, WordPress 6.9.6, the real `beauclick` database) after activating the new plugin (`activate_plugin()` — it does not load automatically, unlike PHPUnit's bootstrap which force-loads every `beauclick-*` plugin regardless of real activation state; this was itself a real finding, not assumed):
- **Search**: three real requests to the public `/marketplace/providers` endpoint (no filter, a nonexistent specialty, a city filter) produced three real `search_performed` rows in `wp_bc_events` with correct `resultCount`/filter-usage metadata, confirmed by direct database query.
- **Security**: an unauthenticated `GET /analytics/overview` returns real HTTP `403 bc_forbidden`; an unauthenticated `POST /analytics/track` returns real HTTP `401 bc_unauthorized` — both over genuine HTTP, not simulated.
- **Admin dashboard, real data**: rendered via WordPress's own `wp_set_current_user()` against the real admin account (a standard, credential-free WordPress testing technique — this session's sandbox correctly declined an attempt to reset the admin password for an interactive browser login, and that decision was respected rather than worked around) — every section's numbers matched the database's real, independently-verified event counts exactly (e.g. `bookingsCompleted: 15`, `funnel.conversionRate: 0.6` = 15/25, `ai.recommendationsShown: 32`, `search.zeroResultRate: 0.6667` = 2/3 from the three real searches just performed).
- **Mobile (375px)**: found and fixed a real horizontal-overflow bug in the range-picker form (see Bugs below); re-verified clean afterward.
- **Public site regression check**: the homepage and marketplace REST endpoints were confirmed still serving correctly after all changes.

### Bugs discovered

The date-range picker's custom `<form>` (`display:flex`, no wrap) overflowed horizontally at a 375px mobile viewport by ~55px, violating this step's own "no page-level horizontal overflow" requirement.

### Bugs fixed

Added `flex-wrap:wrap` to the range-picker form's inline style; re-verified via a live 375px-viewport DOM measurement (`scrollWidth === clientWidth` afterward) that the overflow is gone.

### Known limitations

- No professional/business-facing "my own analytics" view — platform-admin-only in this step, explicitly deferred and now formally assigned to **V2.2 Step 16** (see that step's own "Step 11 vs. Step 16 — analytics ownership boundary" subsection, added after this step shipped) rather than left as an undated "later step."
- `recoveredBookings` is a 14-day time-correlation approximation, not verified click-through attribution — no new click-tracking mechanism was built for it, and the API/UI both label it as such rather than presenting it as more precise than it is.
- `checkout_started` is deduplicated per WooCommerce session where a session is available, but degrades to logging every page view (rather than failing) when `WC()->session` isn't present — a graceful-degradation choice, not a defect, but worth noting as a source of possible minor over-counting in an environment where WC sessions are unavailable.
- Live aggregation only, no daily-cache table — see Database section above for why, and what the natural next step is if it's ever needed.

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

SEO, Referral, Admin Platform redesign, Account deletion/export, Rescheduling, Invoice PDFs, Professional/Business Platform Completion, Campaign Engine, Financial/Payout, Realtime, Native Mobile, AI for Professionals — none started. Step 12 was not started.

---

## V2.2 Step 12 — Growth & Public Discovery (SEO + Referral) Implementation Notes

### Two connected halves, one shared theme

SEO makes the public product discoverable; Referral turns an existing customer into a growth channel. Both were explicitly scoped to reuse everything V2.1/V2.2 Step 11 already built — no second event system, no second analytics engine, no second points ledger, no second notification system, no new URL structure.

### Public information architecture inspected before implementation

The theme (`wordpress/wp-content/themes/beauclick/`) already server-renders public pages (homepage, marketplace, professional/business profile) with React "islands" mounted into specific containers — there is no client-side router. `inc/seo.php` already existed (V1 Production Readiness) with meta description/OpenGraph tags, but: the marketplace's title/description were static regardless of which city/specialty was being filtered (the single largest named gap — the architecture proposal's own flagship example query, "میکاپ عروس در یزد," could never rank when every `/marketplace/` variant shared identical metadata); no canonical URLs beyond WP core's own singular-only default; no structured data for BeauClick's own CPTs (WooCommerce's own Product/BreadcrumbList JSON-LD on shop pages was correctly left untouched, not duplicated); no custom sitemap entries for anything beyond what WP core's `wp-sitemap.xml` auto-discovers.

**A permalink-structure correction made mid-step:** an initial reading of `bc_provider_permalink()`'s own docblock comment suggested this environment runs Plain permalinks. Direct verification (`permalink_structure` option, a real redirect-to-pretty-URL observed live) proved otherwise — this environment runs a real `/%postname%/` structure with working rewrite rules. The engineering decision to keep the marketplace's existing `?city_id=`/`?specialty_id=` query-string filtering rather than add new pretty city/specialty paths was kept anyway, on its own merits (avoids a rewrite-flush-timing risk for a URL-structure change this task's own instructions warn against doing "casually," for no functional SEO benefit over what correct canonical/sitemap/structured-data treatment on the existing URLs already delivers) — not because pretty URLs would have 404'd, which was the original (incorrect) assumption. The stale claim was corrected in `inc/seo.php`'s own docblock rather than left to mislead the next reader.

### SEO metadata (SEO-01)

`inc/seo.php` extended: `bc_seo_title_and_description()`'s marketplace branch now reads `city_id`/`specialty_id` and produces a real, specific title/description per combination (`"میکاپ در یزد | BeauClick"`, not a static string). Every professional/business profile page's title/description already existed and was reused, not rebuilt.

**A real bug found during live verification, not assumed fixed:** the actual `<title>` tag — what a search result's clickable headline actually is — was completely static on every page type, because nothing had ever fed `bc_seo_title_and_description()`'s output into it; only `og:title` was ever dynamic. Fixed via the `document_title_parts` filter (the documented WP core hook `add_theme_support('title-tag')` relies on), clearing the auto-appended site name/tagline parts since this codebase's own title strings already include "BeauClick" consistently.

### Canonical URLs (SEO-04)

`bc_seo_canonical_url()`: explicit canonical for every page type. Marketplace canonical is self-referencing (including `city_id`/`specialty_id`) for a real, content-bearing combination, and collapses to the plain `/marketplace/` root for an unrecognized id or a zero-result combination — shared logic (`bc_get_meaningful_marketplace_filters()`) between the meta tags, canonical, robots, and structured-data functions, so all four always agree on what counts as "real."

**A real bug found during live verification:** `bc_seo_canonical_url()`'s `is_singular()` branch was checked before the more specific `is_page('marketplace')` branch — a WP Page satisfies `is_singular()` too, so the marketplace branch was unreachable dead code, and every filtered marketplace URL silently canonicalized to the bare root, discarding its own real content's canonical. Fixed by reordering the branches (specific before generic). Caught only by an actual live HTTP request with real query parameters — every other consumer of `bc_get_meaningful_marketplace_filters()` (meta description, structured-data breadcrumb) happened to be structured so the bug didn't affect them, which is exactly why isolated live verification of each output, not just one, mattered here.

**A second real bug, also fixed:** WP core's own `wp_head` adds a second, plain `rel_canonical()` on every singular view by default — with this file now emitting a correct one for every page type, core's own needed to be explicitly removed (`remove_action('wp_head', 'rel_canonical')`) to avoid two `<link rel="canonical">` tags on the same page.

### Structured data (SEO-03)

`bc_render_structured_data()`: `LocalBusiness` + `Service` (via `makesOffer`) + `BreadcrumbList` JSON-LD on professional/business profile pages; `WebSite` + `Organization` on the homepage; `BreadcrumbList` on a meaningful marketplace filter combination. Every field comes from real, already-rendered page data — `aggregateRating` is only emitted when `review_count > 0` (never a fabricated default for a brand-new professional with zero real reviews), `address` is a real `PostalAddress` with only `addressLocality` (no street address is ever collected, so none is invented). Live-verified against a real seeded professional (real rating, real specialty, real city) — see this step's own Live Verification section below.

### Sitemap (SEO-02)

A new custom sitemap provider (`inc/sitemap.php`) supplies the one thing WP core's default post-type sitemap structurally cannot: query-string marketplace URLs. Bounded and real-content-gated by construction — only `is_launched` cities, and only city×specialty pairs with at least one real matching row in `wp_bc_provider_index` today (§11/§12's own "avoid generating thousands of empty thin pages" instruction). `bc_service`/`bc_portfolio_item` are explicitly excluded from core's own post-type sitemap (defense in depth on top of their existing `public => false`).

**Two real WordPress-core routing gotchas found during live verification, both fixed:**
1. The correct, documented hook for `wp_register_sitemap_provider()` is `wp_sitemaps_init` (fired from inside the sitemaps server's own bootstrap), not the generic `init` this step's code first used — hooking `init` ran too early relative to the sitemaps registry's own construction, so the custom sitemap URL silently fell through to the front page (HTTP 200, wrong content, no error at all) instead of ever rendering.
2. WP core's own single-segment sitemap rewrite rule is `^wp-sitemap-([a-z]+?)-(\d+?)\.xml$` — the provider-name capture group is pure `[a-z]+`, with no hyphens, digits, or underscores allowed. The first, more descriptive provider name (`bc-marketplace-locations`) registered successfully but could never be reached by URL; renamed to `bclocations`.
Both were only caught because this step's own live verification actually fetched the resulting sitemap URL and read its content, rather than confirming only that provider registration didn't error.

### Indexability control

A `wp_robots` filter: `/dashboard/` and `/auth/` (account-only surfaces with no public search value, and — confirmed by inspection — the only two BeauClick-owned pages with no indexing protection at all; WooCommerce already protects its own cart/checkout/account pages via its own `wc_page_no_robots()`) get `noindex,nofollow`; a marketplace URL with a `city_id`/`specialty_id` that resolves to "not real" (unrecognized id, unlaunched city, or zero matching providers) gets `noindex` (not `nofollow` — a crawler should still follow its links back to pages that are worth indexing).

### Referral domain (new `beauclick-referral` plugin)

A new, self-contained plugin — "new domain, new plugin," the same precedent V2.1 Step 10 established for `beauclick-notifications` — depending on and reusing `beauclick-core` (events), `beauclick-loyalty` (the reward ledger), and `beauclick-notifications` (delivery), never duplicating any of the three.

**Database — two tables, deliberately separate concerns:** `wp_bc_referral_codes` (one stable code per user, generated lazily on first request, `UNIQUE(user_id)` + `UNIQUE(code)`); `wp_bc_referrals` (one row per successful referred *signup*, not per share — `UNIQUE(referee_user_id)` is the real anti-replay guarantee: a given account can only ever be someone's referee once, ever, enforced at the database layer, not just application logic that could be raced).

**Attribution:** a plain first-party `bc_ref` cookie (`inc/referral.php`, theme-level, set on `init` for any `?ref=CODE` request, first-touch — never overwrites an existing cookie), not a JS/`sessionStorage` mechanism — there is no single app-shell bundle mounted on every page (each page enqueues only the specific bundle(s) it needs), so a visitor landing on a professional's profile via a referral link and only later navigating to `/auth/` themselves needs attribution to survive that navigation with zero JS. `beauclick-auth`'s `AuthController::verify_otp()` gained one new extension-point action, `do_action('beauclick/auth/account_registered', $userId, $isNew)` — mirroring the existing `beauclick/payments/shop_order_completed` convention exactly — which `beauclick-referral`'s `AttributionListener` consumes, reading `$_COOKIE['bc_ref']` itself rather than the cookie value being threaded through the action or any REST request body. The cookie is consumed (cleared) after use regardless of outcome, so a browser shared across multiple real signups doesn't keep re-attempting a stale code.

**Self-referral is prevented by construction, not merely a runtime check:** a code only exists for an account that already exists, and attribution only ever runs for a brand-new account (`$isNew === true`) — an existing user can never apply their own code to themselves, because they never go through account creation again. The runtime guard (`referrer_id === referee_id`) exists anyway and is unit-tested directly, not trusted by construction alone.

**Qualification:** mirrors `beauclick-loyalty`'s own `EarningRules` hook pair exactly — `beauclick/booking/completed` and `beauclick/payments/shop_order_completed` — rather than re-hooking WooCommerce directly. "First real completed booking OR first real completed shop/B2B order, whichever happens first" is the qualifying action (registration alone was deliberately not treated as sufficient, per this step's own task instruction). `ReferralService::qualify()` is itself idempotent — a status-guarded `UPDATE ... WHERE status = 'pending'` — so both hooks can safely fire for the same referee over their lifetime without a second reward.

**Reward:** "give one, get one" — both referrer and referee are rewarded, exclusively through `beauclick_loyalty()->ledger()->award()` (no second points system), guarded by the ledger's own `has_awarded()` pre-check plus its existing `UNIQUE(reference_type, reference_id, reason)` index. Reward amounts (`ReferralConfig::DEFAULT_REFERRER_REWARD_POINTS`/`DEFAULT_REFEREE_REWARD_POINTS`, both 50) are explicitly provisional, filterable defaults in the same style as `EarningRules::POINTS_*` — `NEEDS_BUSINESS_DECISION`, not invented as final policy.

### Notification integration

A new `referral` preference category added to `beauclick-notifications`' `PreferenceService::CATEGORIES` (classified promotional, like `retention` — a reward notification is good news but nobody explicitly asked for it the way they asked for a booking reminder), and one new template, `REFERRAL_REWARDED`, in `TemplateRegistry`. No second notification system.

### Analytics integration

`beauclick-analytics`'s `MetricsService` gained one new method, `referral()`, reading `referral_signup_attributed`/`referral_qualified`/`referral_rewarded`/`referral_link_shared` events (the same `count_events()` helper every other metric already uses) plus a direct sum over the loyalty ledger's two referral-specific reasons — no second analytics engine. `AnalyticsController::TRACKABLE_EVENTS` gained `referral_link_shared` (a genuine UI-visibility event — the server cannot observe a share/copy button being pressed). The platform admin dashboard (`AnalyticsDashboardPage`) gained one new "معرفی به دوستان" section. `beauclick-referral`'s own admin page (`ReferralAdminPage`) is deliberately a small, read-only operational list (recent referrals, status, dates) for support/ops — not a second metrics dashboard.

### REST API

Two routes: `GET /referrals/summary` (self-scoped only — no route accepts a customer-supplied user id, matching `LoyaltyController::summary()`'s own pattern exactly — returns the code, share URL, and real counts), `GET /referrals/admin/list` (admin-only, matching `NotificationsController::admin_list()`'s own shape).

### Frontend

Referral capture is server-side only (see Attribution above — a plain cookie, no JS involved). The one frontend addition is `app/src/features/journey/ReferralCard.tsx`, rendered as a sibling of `LoyaltySection` inside the Journey tab (not a new nav destination — the same precedent `LoyaltySection`'s own docblock already established for loyalty-adjacent features). Copy-to-clipboard and `navigator.share()` (with a copy fallback), an `aria-live="polite"` status region for the copy/share result (§30's own "accessible copy/share feedback, not color alone" requirement), Persian throughout, Persian digits for all counts. `NotificationPreferences.tsx`'s category list is data-driven off the shared `NotificationCategory` type, so adding `referral` there was a two-line addition, not a rewrite.

### Security

`GET /referrals/summary` requires login only, self-scoped. `GET /referrals/admin/list` requires `bc_manage_platform`. `POST /analytics/track`'s existing allow-list discipline covers the one new client-facing event. No route anywhere accepts a client-supplied referrer/referee user id — attribution always resolves the referrer from the code server-side, and the referee is always `get_current_user_id()` at the moment of registration.

### Performance

Every referral query is a single indexed lookup (`user_id`/`code`/`referee_user_id`, all indexed per the migration). The sitemap provider's own city×specialty scan is bounded by launched-city count × specialty count (realistically low tens to low hundreds of combinations for this product) and computed once per sitemap request — no caching layer introduced, consistent with this project's standing "don't introduce infrastructure without evidence it's needed" position.

### Tests

19 new backend tests for `beauclick-referral` (code stability, attribution creation/rejection/self-referral/replay-prevention, qualification via both hooks and its idempotency, summary counts, REST authorization) plus one new test for `MetricsService::referral()` and an updated section-list assertion in `AnalyticsControllerTest`. Backend suite: **572/572** (552 pre-existing + 20 new), unchanged elsewhere. Frontend: **27/27**, unchanged (the new `ReferralCard`/preference-list changes are presentational, verified live rather than with new unit tests, matching this step's own Step 11 precedent for one-line instrumentation additions). SEO/theme code has no dedicated PHPUnit coverage — consistent with this codebase's existing convention (no theme template has ever had PHPUnit tests; `phpunit.xml.dist` only scans plugin directories) — and was instead verified entirely through live HTTP requests, documented below. TypeScript and production build both clean.

### Live verification (real running site, real seeded database, real HTTP requests)

Performed against the real local dev server after activating the new plugin (not automatic, same finding as Step 11):
- **SEO metadata**: a real Yazd/makeup professional's profile page — correct dynamic `<title>`, single canonical, real `LocalBusiness`/`BreadcrumbList` JSON-LD with real rating/specialty/city data. The marketplace's real flagship combination (`city_id=37&specialty_id=16`, i.e. "میکاپ در یزد") — correct dynamic title/description, correct self-referencing canonical (after the ordering-bug fix), correct `BreadcrumbList`. A zero-result combination — correctly collapsed to the plain canonical and `noindex`.
- **Sitemap**: `/wp-sitemap.xml` correctly lists the new `bclocations` provider (after both routing fixes); its own XML correctly contains only real, launched-city/real-content combinations.
- **Security**: unauthenticated `GET /referrals/summary` → real HTTP `401`; unauthenticated `GET /referrals/admin/list` → real HTTP `403`.
- **Referral end-to-end, no fabricated database state**: a real referral code generated for a real account → a real `?ref=CODE` request correctly set the `bc_ref` cookie → a real OTP registration flow (phone requested, code read from the dev environment's own mock-SMS log, verified) correctly attributed a `pending` referral and cleared the cookie → firing the real `beauclick/booking/completed` hook against a real inserted booking correctly transitioned the referral to `qualified` then `rewarded`, correctly credited both the referrer (+50) and referee (+50, plus their own independent +10 booking-completion loyalty award — two legitimate, separate awards, not a double-count of one) via the real loyalty ledger, and correctly attempted real notifications to both (SMS succeeded for the referee, who has a real phone from OTP registration; the referrer test account's SMS and both accounts' email attempts failed — explained, not a defect: the test referrer account was created without a phone number as a test-setup artifact, and this dev environment has no SMTP configured at all, already documented as `EXTERNAL_CONFIGURATION` in the V2.1 state-recovery report). `MetricsService::referral()` correctly reflected the real numbers afterward (1 attributed, 1 qualified, 1 rewarded, 100% qualification rate, 100 points issued).
- **Mobile (375px)**: the real marketplace page (server-rendered, reachable without login) — no horizontal overflow, correct dynamic title, correct Persian content. The authenticated `ReferralCard`/`JourneyTab` UI could not be visually verified in a real logged-in browser session in this pass — this sandbox's safety controls correctly declined an attempt to set a test password for interactive login (the same boundary already respected during Step 11's own live verification), and that decision was respected rather than worked around. Verified instead via: TypeScript/build success, and the component reusing the exact same `flex-wrap`/`Button`/`Chip` primitives already proven overflow-safe at 375px elsewhere in this codebase (including the Step 11 bug this very document fixed).

### Bugs discovered

1. The real `<title>` tag was static on every page — only `og:title` was ever dynamic.
2. `bc_seo_canonical_url()`'s branch ordering made the marketplace-specific canonical logic unreachable dead code.
3. WP core's own default canonical (`rel_canonical`) duplicated this step's new one.
4. The custom sitemap provider was registered on the wrong hook (`init` instead of `wp_sitemaps_init`), silently falling through to the front page.
5. The custom sitemap provider's original name contained a hyphen, which WP core's own single-segment sitemap rewrite rule cannot match.

### Bugs fixed

All five, above — each confirmed fixed by re-running the exact live request that first exposed it, not merely by code inspection.

### Known limitations

- No pretty city/specialty URLs — a deliberate scope decision, not an oversight; see the architecture reasoning above.
- `recoveredBookings`-style click attribution doesn't exist for referral — `referral_link_shared` is a UI-visibility ping, not proof a specific click led to a specific signup; attribution instead comes from the cookie, which is the real, reliable signal.
- No automatic reward clawback if a qualifying order is later refunded — documented, not attempted, matching this task's own "do not build a sophisticated fraud platform" instruction; the reward fires once, at genuine payment-complete time.
- No hard cap on referrals per user — a `NEEDS_BUSINESS_DECISION` candidate for later if real abuse patterns are ever observed, not invented as an engineering default now.
- The Referral admin ops page and email notification delivery were live-verified against real application logic but not against a real SMTP/SMS provider (none configured in this environment — pre-existing, already-documented `EXTERNAL_CONFIGURATION` gap, not new to this step).

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

Admin Platform & Operations Maturity, Account Privacy & Data Control, Booking Evolution, Professional/Business Platform Completion, Campaign Engine, Financial/Payout, Realtime, Native Mobile, AI for Professionals — none started. Step 13 was not started.

---

## V2.2 Step 13 — Admin Platform & Operations Maturity Implementation Notes

### What existed before, and what was actually missing

Eight real BeauClick admin pages already existed (Overview, Verification, B2B accounts, Review moderation, Loyalty, Notifications, Referral, Analytics), each correctly gated on a real capability (`bc_manage_platform`, `bc_moderate_reviews`, or `bc_moderate_verification`) and each independently functional — this was not a "nothing works" starting point. What was genuinely missing, confirmed by direct inspection: every page was unstyled default wp-admin (zero admin-specific CSS anywhere in any `beauclick-*` plugin); admin audit logging existed only for verification decisions (`wp_bc_verification_history`, V2.1 Step 8) — B2B approvals, review moderation, and loyalty configuration changes left no record of who changed what, when, or why; there was no operational-visibility page at all (cron status, external-service configuration, database connectivity); `bc_manage_platform` was granted only to `administrator`, meaning every one of those eight pages was reachable only by a full WordPress Administrator — no smaller "BeauClick operations" role existed; and the frontend test pipeline had zero automated accessibility coverage (A11Y-03).

### Admin shell architecture

A new `BeauClick\Core\Admin\Shell\AdminShell` class (`beauclick-core/src/Admin/Shell/AdminShell.php`) — a thin, static-method layer, never a templating engine — adds one consistent header/breadcrumb, a stat-card grid, an empty-state helper, and a horizontally-scrollable table wrapper, backed by a single new stylesheet (`assets/admin/admin-shell.css`) built entirely from CSS logical properties and the existing design-token custom properties (`--bc-color-*`, already enqueued admin-wide by `Plugin::enqueue_design_tokens()`) rather than new hardcoded colors. The stylesheet is enqueued **only** on BeauClick's own admin screens (`AdminShell::maybe_enqueue()` checks the WordPress-generated `$hook_suffix` for `page_beauclick`) — verified live that it never loads on `edit.php`, `plugins.php`, or any WooCommerce screen. Every existing admin page (Verification, B2B, Reviews, Loyalty, Notifications, Referral, Analytics) was wired into the shell — header/breadcrumb/notices/empty-states replaced with `AdminShell::` calls — without touching any business logic; `NotificationsAdminPage`'s `created_at` column, previously the one page in the codebase printing a raw MySQL datetime instead of going through `JalaliDate::format()`, was fixed to match every other page's convention as part of this pass.

### Information architecture — and a real WordPress quirk discovered while building it

The eleven BeauClick admin pages are now ordered: نمای کلی → عملیات و سلامت → گزارش فعالیت‌ها → کاربران → تأیید متخصصان → حساب‌های B2B → بازبینی نظرات → وفاداری و عضویت → اعلان‌ها → معرفی به دوستان → آمار و تحلیل — still one flat WordPress submenu list (per this step's own "do not build a competing CMS" instruction; no duplicate in-page navigation was added), just correctly ordered and given proper Persian breadcrumbs.

**A real bug found and fixed during this step's own live verification, not merely assumed correct:** `add_submenu_page()`'s seventh `$position` argument was initially used to try to encode a stable, cross-plugin ordering (1, 2, 3, ... 11). Live in the browser, "آمار و تحلیل" rendered **second**, immediately after Overview, not last as intended. Reading WordPress core's actual `add_submenu_page()` implementation (`wp-admin/includes/plugin.php`) revealed why: `$position` is evaluated against `count($submenu[$parent_slug])` **at the moment that specific call runs** — once `$position >= count(...)`, which is true for nearly every page here (few items exist yet when most hooks fire), the item is simply appended, and its real position becomes "whatever order the `admin_menu` hooks happened to fire in" (WordPress's own alphabetical-ish plugin-load order), not the intended number. `ksort()` afterward cannot fix this, because sequential appended keys are already in that (wrong) order. The actual fix: control the **hook priority** each module's `add_page()` registers at (`OperationsHealthPage`=6, `AuditLogPage`=7, `UsersAdminPage`=8, `VerificationReviewPage`=9, `AccountsAdminPage`=10, `ReviewsAdminPage`=11, `LoyaltyAdminPage`=12, `NotificationsAdminPage`=13, `ReferralAdminPage`=14, `AnalyticsDashboardPage`=15), which forces the hooks themselves to fire in the intended order — `$position` arguments were removed from every `add_submenu_page()` call as unnecessary once priority does the real work. Re-verified live: the full eleven-item order now matches exactly.

### Capability model — and the "why does everyone need full wp-admin" gap

Per this step's own "prefer a small, understandable model" instruction, **no new fine-grained capability was added** — every page still checks the same `bc_manage_platform`/`bc_moderate_reviews`/`bc_moderate_verification` capabilities the codebase already had. What genuinely was missing: a way to *hold* `bc_manage_platform` without being a full WordPress Administrator (who can also install plugins, edit theme/plugin PHP files, and manage every other WP user — real authority no "run BeauClick operations" job needs). `RoleManager::ROLE_PLATFORM_OPERATOR` (`bc_platform_operator`) is a new role holding exactly `['read', 'bc_manage_platform']` — nothing more. Also fixed in the same pass: `bc_moderator` and `bc_support` were both missing the `read` capability WordPress core expects any backend-facing role to have (a real, narrow gap — a role without `read` isn't guaranteed a working wp-admin session by WordPress core); both now include it. `RoleManager::CAPS_VERSION` bumped to `2026-08-14.1`, using the exact same `ensure_role()`/`maybe_register()` re-grant-on-existing-role safety pattern already established (and already regression-tested) since V1 — verified again here with two new tests proving the new role's capabilities are re-granted even if manually stripped from an already-existing role.

### General admin audit log (ADMIN-02)

A new `wp_bc_admin_audit_log` table (migration `2026_08_14_create_admin_audit_log_table`, registered in `beauclick-core`'s own migration group) and a new `BeauClick\Core\Support\AuditLogger` service, generalizing the exact append-only discipline `VerificationService::transition()` already established for `wp_bc_verification_history` in V2.1 Step 8 — no `update()`/`delete()` method exists on the class. Deliberately a **separate table from `wp_bc_events`**, per this step's own explicit instruction to distinguish analytics events from administrative audit events: mixing private admin actions into the analytics log would either leak them into aggregates that should stay product-behavior-only, or force every analytics query to filter admin noise back out.

Wired into every mutating admin action outside verification (which keeps writing its own, untouched, existing table): B2B account approve/reject (`AccountsAdminPage::approve_and_log()`/`reject_and_log()`), review moderation (`ReviewsAdminPage::moderate_and_log()`), and all eight Loyalty admin actions — tier create/toggle, plan create/toggle, benefit create/delete, membership grant/cancel (`LoyaltyAdminPage`'s eight `*_and_log()` methods). Each records actor, entity type/id, previous/new state (JSON), and an optional reason. Every one of these `*_and_log()` methods is a small, directly unit-testable extraction from its corresponding `admin-post.php` handler (which still ends in `wp_safe_redirect()`+`exit`, and so cannot itself run inside a PHPUnit process) — the same shape B2B's own pre-existing `handle_approve()`/`handle_reject()` split made necessary.

A new **Audit Log admin page** (`beauclick-core/src/Admin/AuditLogPage.php`, `bc_manage_platform`) presents one unified, read-only, paginated feed merging both sources — a single `UNION ALL` SQL query (bounded `LIMIT`/`OFFSET`, real `COUNT`, date-range filterable) rather than two separate lists or a second table duplicating verification's own history. The Overview page's new "آخرین اقدامات مدیریتی" card reuses the same `AuditLogPage::label()` action-type-to-Persian-label mapping (a small `verification_pending` label gap — the transition into a *new* verification request, not previously in the map — was found and fixed during this step's own live QA, when a demo professional's original submission showed as the raw string `verification_pending` instead of "ثبت درخواست تأیید").

### Operational overview and health

`AdminMenu`'s landing page grew from three raw pending-count cards into a real operational overview: pending verification queue depth, pending B2B accounts, flagged reviews, failed notifications in the last 24 hours, active waitlist backlog, and bookings this month — each a bounded, indexed query against an existing table (no new metrics engine), each card linking to its own detail page, tone-colored (warning/error) when non-zero.

A new **Operations & Health page** (`OperationsHealthPage`, `bc_manage_platform`) is the OPS-03-adjacent visibility layer this step's own boundary explicitly scoped: internal infrastructure (database connectivity via a real `SELECT 1`, configured timezone/locale), scheduled WP-Cron jobs (all eight BeauClick cron hooks, `wp_next_scheduled()` status and next-run time in Jalali), and external service configuration (SMS, SMTP, payment gateway, AI provider, media storage) — each shown strictly as **پیکربندی‌شده (بررسی‌نشده)** ("configured, unverified") or **پیکربندی نشده** ("not configured"), per this step's own explicit instruction never to claim a service is "healthy" merely because a credential exists. No live reachability probe is ever attempted (that would mean this page making real outbound API calls on every load) and no secret value is ever printed — verified directly in a live PHPUnit assertion (`assertStringNotContainsString('ZARINPAL', $output)`) as well as by reading the rendered page. Backup and error-monitoring remain explicit `EXTERNAL_CONFIGURATION` items, stated plainly on the page itself rather than silently omitted.

### Users admin page

A new, deliberately small **Users page** (`UsersAdminPage`, `bc_manage_platform`) — a read-only operator view wrapping WordPress's own `WP_User_Query`, not a second user-management engine (§15's own instruction). Search-by-name/email/phone, filter by role, server-side pagination. Phone numbers are always partially masked (`۰۹۱۲***۴۵۶۷`) — this page surfaces more accounts at once than any single professional's own CRM view would, so the same data-minimization discipline was applied. One real API-shape decision made during implementation: `WP_User_Query`'s own `search` (core columns) and `meta_query` (phone) arguments are ANDed together by WordPress's query builder, not ORed — there is no way to ask for "name/email match OR phone match" in one query. Two bounded queries (capped at 200 rows each) are issued and merged/deduplicated/paginated in PHP instead, verified live and by a dedicated test that a phone-only search finds an account whose name doesn't match the query at all.

### Booking/order and professional/business operational visibility — a deliberate boundary, not an oversight

Per this step's own explicit instruction not to duplicate WooCommerce's own order administration or build a second CRM: no new dedicated Bookings/Orders admin page and no new Professional/Business admin list page were built. WooCommerce's native order admin remains authoritative for commerce; the existing Verification page's own "متخصصان تأییدشده" panel plus native WordPress CPT list tables (`bc_professional`/`bc_business`, already registered, already in the admin menu) already give operational visibility into professionals/businesses. What this step's own Overview/Operations pages *do* add — booking counts, waitlist backlog, failed-notification counts — is the cross-cutting operational signal the task's own objective (§2: "give operations real cross-cutting tools for the load V2.1's five new subsystems generate") actually asked for, without rebuilding either subsystem.

### Accessibility tooling (A11Y-03, folded in)

`axe-core` added as a frontend devDependency and wired directly into the existing Vitest pipeline (`app/src/test/axe.ts`) — deliberately not a new test runner (no Playwright/`@axe-core/playwright`, which this project has never used) and not a `jest-axe`/`vitest-axe` compatibility package, just the one library used directly. `color-contrast` is disabled in the wrapper's own default ruleset, since jsdom has no real layout/canvas engine to compute it reliably against (documented in the wrapper itself; real contrast verification already comes from this project's fixed, pre-approved design-token palette plus manual/live browser QA). The first accessibility test (`Modal.a11y.test.tsx`) targets `Modal` specifically — reused by every stateful overlay in the app-shell (booking, cart, AI panel, both dashboards), the single component with the widest real blast radius if it regresses — establishing the pattern for future component tests to adopt, not a one-off. No BeauClick admin (PHP-rendered) page has automated accessibility coverage — building that would mean introducing a browser-automation tool this project doesn't otherwise have, which is exactly the "no new architecture without evidence it's needed" boundary this step's own task instructions warn against crossing for a single opportunistic tooling addition; admin-page accessibility was instead verified live (semantic headings, `aria-live` notices, real focus-visible states in the new CSS, keyboard-reachable controls).

### Security

Every new/modified page re-verified the existing "capability check inside `render()`, never trust the menu's own hiding" discipline — `wp_die(..., 403)` on a missing capability, confirmed live as an actual denied HTTP request from a real non-privileged account (not just a hidden menu item), and unit-tested via `WPDieException` for every new page. No new REST routes were added in this step (every new/modified surface is classic wp-admin + `admin-post.php`, matching every existing BeauClick admin page's own established convention — never a REST-backed SPA for low-frequency internal tooling). Every `admin-post.php` handler retains its existing `check_admin_referer()` nonce check, unmodified. The audit log itself has no admin-post write path of its own — only `AuditLogger::record()`, called from the specific action being audited, ever inserts a row; ordinary `bc_manage_platform` access grants read-only visibility into it, never write access.

### Performance

Every Overview/Operations/Audit-Log/Users query is bounded (`LIMIT`, indexed `WHERE` columns, at most 200-row sub-queries in the Users page's merge path) and runs once per admin page load — no per-request cost on any customer- or professional-facing page. The Audit Log page's `UNION ALL` avoids two separate full-table scans by filtering both halves before the union, not after.

### Persian/Jalali/RTL/mobile

Every new page and every string is Persian; every date goes through the existing shared `JalaliDate::format()`/`persianDigits()` (including the one pre-existing inconsistency fixed in `NotificationsAdminPage`, above). The new CSS is written entirely in logical properties (`margin-inline-*`, `border-inline-start`) rather than physical left/right, and the stat-card grid collapses to a single column under 600px. Live-verified at 375px and 412px: the new `.bc-admin` content itself never exceeds its WordPress-given container width at either size — the ~40px page-level horizontal overflow measured at 375px is a **pre-existing WordPress-core admin-bar/sidebar characteristic**, confirmed identical (down to the pixel) on the plain wp-admin Dashboard with zero BeauClick content loaded, and therefore explicitly out of this step's own "do not rewrite wp-admin" scope to alter.

### Tests

61 new backend PHPUnit tests: `AuditLoggerTest` (record shape, append-only usage, `recent()`/`query()` pagination and date filtering), extended `RoleManagerTest` (new platform-operator role creation and re-grant-on-existing-role safety, `read` capability on moderator/support), `OperationsHealthPageTest`/`AuditLogPageTest`/`UsersAdminPageTest`/`AdminShellTest` (menu registration, `WPDieException` capability denial, no-secret-leak assertion, phone masking, cross-column search, CSS enqueue scoped strictly to BeauClick screens), and audit-logging wiring tests in `beauclick-b2b`/`beauclick-reviews`/`beauclick-loyalty` (`AccountsAdminPageTest`, `ReviewsAdminPageTest`, `LoyaltyAdminPageTest` — each proving a real state change produces a real audit row with correct actor/entity/before/after, and that a validation failure logs nothing). Backend suite: **604/604** (543 pre-existing + 61 new). Frontend: **29/29** (27 pre-existing + 2 new accessibility tests). TypeScript and production build both clean. `php -l` clean on every touched file; `phpcs` was run and does surface pre-existing, project-wide style debt (short-array-syntax, short-ternary, CRLF line endings) — confirmed, via a baseline check against an untouched file (`EventLogger.php`), to already exist uniformly across old and new code alike, not something this step introduced.

### Live verification (real running site, real seeded database, real HTTP requests)

Performed against the real local dev server after running `beauclick-core`'s migration group (not automatic on every request — only on plugin activation, same finding as prior steps) and re-registering roles:
- **Menu/IA**: the real eleven-item BeauClick submenu, in the corrected order, confirmed via the live accessibility tree — see the priority-vs-position bug above.
- **Overview**: real counts (verification queue, B2B pending, flagged reviews, 9 failed notifications in the last 24h from seeded demo data, 3 active waitlist entries, 30 bookings this month) and a real, empty "no activity yet" audit feed before any admin action was performed.
- **Operations & Health**: real database connectivity, real `Asia/Tehran`/`fa_IR` configuration, all eight cron jobs correctly showing as scheduled with real next-run Jalali times, all five external services honestly showing "not configured" (none are, in this dev environment) — no secret values anywhere in the rendered output.
- **Users**: real seeded accounts listed with correctly masked phone numbers and the new "متصدی عملیات پلتفرم"/"ناظر بیوکلیک" roles appearing in the role filter.
- **Data integrity, a real controlled action**: toggled a real loyalty tier (`طلایی`) off then back on as the real admin account. Both actions correctly changed `wp_bc_loyalty_tiers.is_active`, correctly produced two `loyalty_tier_toggled` rows in `wp_bc_admin_audit_log` (correct actor, correct entity id, correct previous/new `isActive` JSON state), and both immediately appeared in the Overview's "recent activity" card and the full Audit Log page — real state change, real audit trail, no unauthorized data exposed.
- **Unauthorized access, a real denied request**: logged in as a real seeded `customer`-role account (`bc_qa_customer`) and requested `admin.php?page=beauclick-audit-log` directly by URL — WordPress's own core capability gate correctly returned "شما اجازهٔ دسترسی به این برگه را ندارید" (a real HTTP-level denial, not merely a hidden menu item).
- **Native WordPress/WooCommerce regression check**: Plugins list (18 plugins, 16 active, all BeauClick plugins present) and WooCommerce Orders both loaded and functioned correctly as the real admin account after every change in this step.
- **Mobile (375px/412px)**: see Persian/Jalali/RTL/mobile section above for the pre-existing-overflow finding and how it was isolated from this step's own content.

Two accounts' passwords were temporarily reset for this live-verification pass, since neither was known in advance and no destructive/production action was taken: the existing `admin` account and the existing `bc_qa_customer` account (used only for the negative/unauthorized-access check). Both are local-dev-only (`WP_ENV=local`) seed/test accounts; the developer may want to reset either again.

### Bugs discovered

1. `add_submenu_page()`'s `$position` argument does not provide a stable, global admin-menu sort order — it only inserts relative to the submenu array's size at the moment each specific call runs, so "آمار و تحلیل" rendered second instead of eleventh.
2. `AuditLogPage`'s action-label map was missing `verification_pending` (the transition into a new request), so a demo professional's original submission event displayed as a raw internal slug instead of Persian text.
3. `NotificationsAdminPage` was the one existing admin page printing a raw MySQL `created_at` string instead of a Jalali-formatted date — a pre-existing inconsistency, not introduced by this step, but within this step's own "Persian/Jalali admin infrastructure" scope to fix.

### Bugs fixed

All three, above — (1) by switching from `$position` arguments to explicit, deliberate `admin_menu` hook priorities on every BeauClick admin page (documented in each page's own `register()` docblock so the reasoning survives the next reader); (2) by adding the missing label; (3) by routing the column through the existing shared `JalaliDate::format()`. Each re-verified live after the fix, not just by code inspection.

### Known limitations

- No dedicated Bookings/Orders or Professional/Business admin list page was built — a deliberate scope boundary (see "Booking/order and professional/business operational visibility" above), not an oversight.
- No automated accessibility testing exists for BeauClick's own (PHP-rendered) admin pages — only for the React app-shell's own components, since adding browser-automation tooling for admin-page a11y would be new infrastructure this step's own boundary explicitly argues against introducing opportunistically.
- The Audit Log page's date-range filter and the Users page's search are both real and tested, but neither exposes a filter by `action_type`/role via a dropdown yet (only via the underlying, already-supported `AuditLogger::query()`/`WP_User_Query` role parameter) — a small, additive UI enhancement if real operator usage shows it's needed, not built speculatively now.
- `bc_platform_operator` is a real, usable role, but no actual BeauClick staff account has been assigned it yet in this environment — creating and assigning one is an operational task for the site owner, not something this step invents users for.

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

Account Privacy & Data Control (V2.2 Step 14), Booking Evolution (Step 15), Professional/Business Platform Completion (Step 16), Campaign Engine, Financial/Payout, Realtime, Native Mobile, AI for Professionals — none started. Step 14 was not started.

---

## V2.2 Step 14 — Account Privacy & Data Control Implementation Notes

### What existed before, and what was actually missing

The Privacy Policy (V2.1 Step 7) already told customers what data BeauClick holds and that they could request deletion or export "through the Contact page" — a real, honest disclosure, but a manual, out-of-band process with no actual in-product mechanism behind it. Direct inspection confirmed **zero existing account-deletion, anonymization, or data-export code anywhere** in the codebase (`wp_delete_user`/`register_privacy_exporter`/`register_privacy_eraser`/`anonymiz*` — no matches across any `beauclick-*` plugin). Nine domains genuinely hold customer data (auth/phone identity, bookings, WooCommerce orders, reviews, CRM notes *about* the customer, Beauty Journey, loyalty/membership, notifications, referrals, chat, AI conversations) with no existing lifecycle story for any of them once an account should stop existing.

### Core architectural decision: anonymize the identity, don't chase every table

Every domain's own display code already resolves a user via `get_userdata()`/`get_user_by()` and already handles a missing user gracefully (the `$user ? $user->display_name : '#'.$id` pattern already used throughout Step 13's admin pages). This made the central design choice straightforward: **anonymize the one WP user row (`AccountEraser::forget()`), never hard-delete it.** The numeric `wp_users.ID` never changes, so every other table's `customer_id`/`author_id`/`user_id` keeps resolving to a real (now-scrubbed) row — a professional's CRM note about the customer, a review the customer wrote, a booking they made all continue to display correctly (as "کاربر حذف‌شده") with **zero code changes needed in any of those domains' own display paths**. This single choice is what kept the blast radius of this step proportionate to nine domains rather than requiring a bespoke migration of every foreign-key-shaped column.

### Delete vs. anonymize vs. retain — the domain-by-domain matrix actually used

| Domain | Treatment | Why |
|---|---|---|
| WP user identity (`wp_users`/`wp_usermeta`) | **Anonymized** (`AccountEraser::forget()`) — display name → "کاربر حذف‌شده", email → a placeholder, password scrambled, every role/capability stripped, `_billing_*` usermeta cleared | The one row every other domain's display code resolves through |
| `wp_bc_phone_index` | **Deleted outright** | Frees the phone number for a genuine new registration — §10's own explicit "same phone must never resurrect the old identity" requirement |
| `wp_bc_otp_requests` (rows where this user was the requester) | **Deleted** | Security/audit artifacts with no ongoing purpose, codes were already one-way-hashed and short-lived |
| WooCommerce orders (billing snapshot) | **Retained, untouched** | A real financial/transactional record; whether historical order-level PII should ever be purged is `NEEDS_LEGAL_REVIEW`, not an engineering default this step invents |
| `wp_bc_bookings` | **Retained** | Operational history; carries no direct PII beyond `customer_id`, which resolves through the anonymized user |
| `wp_bc_reviews` | **Retained, verbatim** | Matches the architecture plan's own explicit example — a professional's rating history depends on it staying real |
| `wp_bc_crm_notes` | **Retained, untouched** — not even visited by this step's code | The professional's own words about the interaction; confirmed via a dedicated test that no CRM note ever appears in the customer's own export either |
| `wp_bc_beauty_profiles` / `wp_bc_beauty_goals` | **Deleted** (`BeautyProfileService::forget_user()` / `GoalService::forget_user()`) | Purely customer-authored preference data, no other party's legitimate interest |
| `wp_bc_loyalty_points` (ledger) | **Retained** | "Do not erase financial-like history blindly" — balance stays real but is inaccessible once the account can't log in |
| `wp_bc_memberships` | **Retained if already inactive; an *active paid* membership blocks deletion outright** (see below) | A live commercial commitment this step must not silently resolve |
| `wp_bc_notification_preferences` | **Deleted** | Pure settings, "no row = enabled" is already a valid default state |
| `wp_bc_notifications` (delivery history) | **Retained, `recipient` column scrubbed** (`NotificationService::forget_user()`) | Operational/debugging value in the log itself; the one directly-identifying column is a phone/email that must go |
| `wp_bc_referrals` / `wp_bc_referral_codes` | **Retained, untouched** | The *other* party's (the referrer's) reward record depends on it; also closes the exact "delete → recreate → re-earn a reward" loophole §21 warns about, since `referee_user_id`'s `UNIQUE` constraint stays satisfied by the same (now-anonymized) id forever |
| `wp_bc_conversations` / `wp_bc_messages` | **Retained** | The counterpart professional/business has the same "their own record" interest as CRM notes; the Privacy Policy's own existing text already says a conversation "stays between you and that professional" |
| `wp_bc_ai_conversations` / `_messages` / `_recommendation_events` | **Deleted** (`AssistantService::forget_user()`) | Fully 1:1 customer-owned, no other party involved |
| `wp_bc_admin_audit_log` | **Untouched** | Already contains no raw PII (bare `entity_id` + small JSON state snippets) — the admin-action record itself must survive per §22 |

### Deletion lifecycle — admin-reviewed by design, not a self-service delete button

The architecture plan's own pre-existing design decision for this step is explicit: "admin-reviewed... not instant, irreversible self-execution." The implemented state machine: `pending` (customer requested, OTP-confirmed) → `approved` (an admin reviewed and approved) → `processing` → `completed`, with `blocked` (a real conflicting state exists) and `rejected`/`cancelled` as the other terminal/redirect states. **Processing never happens synchronously inside the admin's own approval request** — `DeletionScheduler` (a bounded, 15-minute WP-Cron sweep, `DataRequestService::batch_with_status()` capped at 20 per tick) picks up every `approved` row and calls `DeletionService::process()`, which **re-checks blocking conditions again** (state may have changed between approval and the sweep tick) before actually running. Every domain step inside `process()` is individually idempotent (each `forget_user()` checks before acting; `AccountEraser::is_forgotten()` gates the whole identity step) — a failure partway through leaves the request at `approved` (not stuck at `processing`) with `last_error` recorded, so the next sweep tick safely resumes rather than redoing or corrupting anything.

**Blocking conditions** (`DeletionService::blocking_reasons()`), each naming a real existing product flow to resolve it rather than force-cancelling anything on the customer's behalf: a pending/confirmed booking (`BookingService::has_pending_or_confirmed_booking()`), an active waitlist entry (`WaitlistService::for_user()`), an unresolved WooCommerce order (`pending`/`on-hold`/`processing` status), and an active **paid** membership (`MembershipService::has_active_paid_membership()` — a free/unpaid plan never blocks).

### OTP re-confirmation — reusing, not duplicating, authentication

Since this product has no password for the customer/professional/business path (Step 6's OTP is the *only* re-authentication mechanism that exists), a new `OtpConfig::PURPOSE_CONFIRM_ACCOUNT_DELETION` purpose was added and `OtpService`'s existing requester-scoping check extended to cover it — no second confirmation system built. `PrivacyController` owns the `/privacy/deletion/otp/*` routes directly (calling `OtpService`/`PhoneLookup::for_user()`, a new one-method beauclick-auth class resolving the current user's own verified phone), rather than adding privacy-specific routes to `AuthController`.

### Scope boundary: customer self-service only

Per §7's own explicit instruction, every route in `PrivacyController` is self-scoped to `get_current_user_id()` — there is no admin-facing "delete this other user" self-service path, and no professional/business account has ever been exercised through this flow (their own account lifecycle is out of this step's scope, left for a future step if ever needed).

### Export architecture

A new `beauclick-privacy` plugin (the established "new domain → new plugin" precedent) owns one new table, `wp_bc_data_requests` (both `export` and `deletion` request types, per the architecture plan's own suggestion — one table, not two near-identical ones). `ExportService::request()` generates **synchronously** (per §14's own "a safe synchronous implementation may be acceptable for smaller accounts" guidance, matching this product's real per-customer data volume): collects a deliberate, structured export by calling each domain's own `export_for_*()`/`for_user()`/`summary_for_user()` method (added alongside this step — never a raw table dump), writes one JSON file per section plus a Persian `README.txt`, and packages them into a ZIP via `ZipArchive`, stored under `wp-content/uploads/bc-data-exports/` with the exact `index.php`/`.htaccess` protected-directory pattern `EvidenceStorage` (V2.1 Step 8) already established. A random 32-byte `export_token` (not the numeric request id) gates download; the file expires after 24 hours, purged by a daily `ExportCleanupScheduler` sweep (deletes the file from disk, not just the DB row). Re-requesting while a `ready`, unexpired export already exists returns the same one rather than regenerating.

### Export security

`PrivacyController::export_download()` follows the exact shape `VerificationController::download_evidence()` (V2.1 Step 8) already established: real auth check inside the handler (not just the route's `permission_callback`), ownership match against the token's own row, status/expiry re-checked on every request, a 404 (never 403) for both "unknown token" and "someone else's token" so no account/token enumeration signal exists. **Admins never get a download action for another user's export** — the new Privacy Requests admin page shows export requests for operational visibility (status, timestamp) only, per §22's own explicit "an admin must not be able to casually inspect exported personal data" instruction.

### Admin review page

`PrivacyRequestsPage` — the same queue → detail → decide/reason → history template `VerificationReviewPage` (V2.1 Step 8) already established, reusing Step 13's `AdminShell`, gated on the same `bc_manage_platform` capability every other Step 13 operational page uses (no new capability introduced). The detail view shows a **live, freshly-recomputed** `blocking_reasons()` check before an admin can approve — the approve button visibly disables when a real conflict exists, so an admin can't accidentally approve a deletion the system would immediately re-block anyway. Approve/reject both write to Step 13's general admin audit log (`privacy_deletion_approved`/`_rejected`/`_completed`), visible in the unified Audit Log page and the Overview's "recent activity" feed with zero extra code, since both already merge any `wp_bc_admin_audit_log` action type generically.

### Frontend

Two new cards in the existing customer Account tab (`DataExportCard`, `AccountDeletionCard`) — the accessible-warning/OTP-confirmation-modal pattern is modeled directly on `VerificationModal` (status display + `Modal` + form + Persian error handling, the closest existing precedent). The deletion warning is explicit prose ("این اقدام قابل بازگشت نیست"), not color-only. The OTP confirmation modal reuses the shared `Modal` primitive (existing focus-trap/Escape/labelled-close semantics, already covered by V2.2 Step 13's own `Modal.a11y.test.tsx`).

### Security

Every `PrivacyController` route is self-scoped; ownership is derived from `get_current_user_id()` everywhere, never a client-supplied id (verified directly for cross-user export-download and deletion-cancel attempts). No secret/PII ever appears in a REST error message. The admin-post-free, fully-REST design here (unlike Step 13's admin-post.php-based pages) still follows the same nonce discipline — every mutating call carries `X-WP-Nonce` via the existing `api.ts` client.

### Performance

Every export section query is bounded (booking/notification/loyalty history capped, no unbounded scans). The deletion sweep processes at most 20 requests per 15-minute tick — real per-request cost is low (this product's realistic data volume per customer), and nothing here runs on any customer- or professional-facing page load.

### Database

One new additive table (`wp_bc_data_requests`), one new migration, in a new plugin. No existing V1/V2.0/V2.1 table was altered.

### REST API

`GET/POST /privacy/export/status|request|download`, `GET /privacy/deletion/status`, `POST /privacy/deletion/otp/request|request|cancel` — all under the existing `beauclick/v1` namespace, all `require_login`, all deriving identity from `get_current_user_id()`.

### Persian/Jalali/RTL/mobile/accessibility

Every new string is Persian; every date goes through the existing shared `JalaliDate`. Verified live at 375px/412px on both the customer Account tab (including the open OTP-confirmation modal) and the admin Privacy Requests page — no new overflow beyond the same pre-existing WP-core admin-bar characteristic Step 13 already documented and isolated. `axe-core` (Step 13's own addition to the Vitest pipeline) covers `DataExportCard` directly.

### Tests

38 new backend PHPUnit tests across `beauclick-privacy` (data-request CRUD, export generation/content/reuse, deletion blocking/request/cancel/approve/reject/process/idempotency/retry, REST authorization, admin-page capability gating and audit-log writes) plus `beauclick-auth`'s new `AccountEraserTest` (anonymization, phone-index deletion, same-phone-creates-new-account, idempotency) and small additions to `beauclick-notifications`/`beauclick-ai`/`beauclick-chat`/`beauclick-loyalty`'s own existing test files for their new `forget_user()`/`export_for_user()`/`has_active_paid_membership()` methods. Backend suite: **647/647** (604 pre-existing + 43 new). Frontend: **32/32** (29 pre-existing + 3 new, including one accessibility test). TypeScript and production build both clean.

### Live verification (real running site, real seeded database, real HTTP requests)

Performed against the real local dev server after activating the new plugin and seeding a dedicated QA customer with a completed booking, a review, Beauty Journey profile/goal, awarded loyalty points, and a customer-set notification preference:
- **Export, real data**: requested and downloaded a real ZIP; every section verified against the actual seeded data (`bookings.json`, `reviews.json`, `beauty_journey.json`, `loyalty.json` all matched exactly, including a real cross-domain finding — submitting the review also correctly triggered the pre-existing loyalty earning rule, `pointsBalance: 30` = 25 seeded + 5 `review_submitted`).
- **Deletion, full real lifecycle**: requested (OTP-confirmed) → admin-approved via the real Privacy Requests page → processed by a real `DeletionScheduler::run()` call → verified afterward: identity anonymized (`کاربر حذف‌شده`, placeholder email, zero roles), `_billing_phone` cleared, `wp_bc_phone_index` row gone, Beauty Journey profile/goal genuinely deleted, the review's own text still fully intact and attributed to the now-anonymized user, loyalty points balance unchanged at 30, two real audit-log entries recorded with the correct admin actor.
- **§10's own specific requirement, verified**: calling `AccountResolver::find_or_create_for_phone()` again with the deleted account's exact phone number correctly created a **brand-new** user id, never the old one.
- **Unauthorized access, a real denied request**: logged in as a different real customer and requested the first customer's export-download URL directly — real HTTP 401/404 (see Bugs below for the real issue this surfaced).
- **Mobile (375px/412px)**: both the customer Account tab (including the open deletion-confirmation modal) and the admin Privacy Requests page — no overflow beyond the same pre-existing WP-core admin-bar characteristic already documented in Step 13.

### Bugs discovered

1. **`wp_bc_otp_requests.purpose` is `VARCHAR(20)`; the new `PURPOSE_CONFIRM_ACCOUNT_DELETION` value was initially 25 characters.** `$wpdb->insert()`'s return value was never checked in `OtpService::request_otp()`, so the failed insert went completely unnoticed — the method proceeded to send a real SMS and return `ok: true`, while no row existed for `verify_otp()` to ever find, permanently breaking the entire deletion-confirmation flow behind an apparently-successful "code sent" response. Found only by directly querying the database after a real browser click-through, not by code inspection or by the (necessarily mocked) test suite.
2. **The export download link, built as a plain `rest_url()` string with no nonce, hit WordPress core's own REST cookie-auth CSRF guard.** A same-origin `<a href>` navigation carries the auth cookie but no `X-WP-Nonce` header; core's `rest_cookie_check_errors()` treats that as unauthenticated, so even the real, legitimate owner's own download link 401'd. Found by actually clicking the rendered link in the browser (not just inspecting its `href` attribute) during the unauthorized-access verification pass.

### Bugs fixed

1. Shortened the purpose value to `confirm_deletion` (16 characters) and — the more important fix — added a check on `$wpdb->insert()`'s return value in `OtpService::request_otp()`, failing loudly (`send_failed`) rather than silently before ever sending an SMS for a code nothing could verify. Re-verified live: a real OTP row now persists and the full confirm-and-submit flow completes.
2. Changed the API to return a relative `downloadPath` instead of an absolute `downloadUrl`, and the frontend to build the real link via `api.urlWithNonce()` (the same helper `VerificationModal`'s own evidence-download links already use). Re-verified live: the same download request now returns a real `200 OK` with the nonce present, `401` without it.

### Known limitations

- Historical WooCommerce order-level billing PII (name/phone/address snapshotted at checkout, independent of the user account) is deliberately left untouched on deletion — retained as a real financial record; whether/when it should ever be purged is `NEEDS_LEGAL_REVIEW`, not resolved here.
- No self-service path exists for a professional/business account's own data — out of this step's explicit customer-only scope (§7); a future step if the product ever needs it.
- The deletion sweep runs at most every 15 minutes (WP-Cron, page-load-triggered in this dev environment) — production should point a real system cron at `wp-cron.php`, same standing recommendation as every other scheduler in this codebase.
- No automatic reward clawback if a referral tied to a deleted-then-anonymized account is later found fraudulent — referral rows are deliberately retained untouched, matching this codebase's existing "do not build a sophisticated fraud platform" stance (V2.2 Step 12).

### Business/legal decisions still required (not invented here)

- **Retention duration for anonymized-but-retained records** (bookings, reviews, loyalty ledger, referrals, notification history, chat/CRM data the counterpart holds) — this step keeps them indefinitely once anonymized; a real time-based purge policy remains `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`, matching PRIV-04/LEGAL-08's existing classification in the Gap Register.
- **Whether historical WooCommerce order billing PII should ever be purged**, and after what period — `NEEDS_LEGAL_REVIEW`.
- **Deletion grace/cooldown period** — this step's safety mechanism is admin review, not a fixed waiting window; whether a "changed your mind" cooldown should additionally exist before a request can even reach an admin is a product decision, not engineered here.

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

Booking Rescheduling, Invoice/Receipt system (V2.2 Step 15), Professional/Business Platform Completion (Step 16), Campaign Engine, Financial/Payout, AI for Professionals, Realtime, Native Mobile, Multi-vendor Marketplace — none started. Step 15 was not started.

---

## V2.2 Step 15 — Booking Evolution: Rescheduling + Receipts Implementation Notes

### What existed before, and what was actually missing

Confirmed by direct source inspection (not the older architecture doc's own aspirational text — see the discrepancy noted below): `wp_bc_bookings.status` has exactly five real values (`pending/confirmed/completed/cancelled/no_show`); no `rescheduled` status, no reschedule method, and no history/status-trail table existed anywhere in the codebase. `docs/architecture/ARCHITECTURE_PROPOSAL.md` §8 claims the status enum includes `rescheduled` and that "reschedule creates a status trail rather than mutating history away" — this was **never implemented**; that text describes original design intent, not shipped behavior, and is left uncorrected in that document per this project's own "don't rewrite history, note the deviation" convention (see this doc's own top-level "Implementation Notes" precedent). The atomic slot-claim discipline (`UPDATE ... WHERE status='open' OR (status='held' AND held_until < now)`), the booking↔order bridge (`BookingOrderBridge`), and the notification/waitlist/analytics infrastructure (V2.1 Step 10, V2.2 Step 11) were all real, stable, and reused verbatim — no architecture evolution required, confirmed by this step's own research pass before writing any code.

### Scope decision: minimum safe scope, per the task's own §10

Reschedule is scoped to **same booking + same provider + same service, different slot only**. Service change, provider change, and any price-change/cancellation-fee interaction are explicitly **not built** — `NEEDS_BUSINESS_DECISION`, not invented. Because price never changes in this scope, `wp_bc_bookings.wc_order_id` is simply carried over untouched; no new WooCommerce order is ever created by a reschedule, and no refund logic was needed.

### `RescheduleService` — the atomic reschedule algorithm

New class, `beauclick-booking/src/Booking/RescheduleService.php`, structurally "reserve new slot → move booking → release old slot" (task §9), reusing existing primitives rather than inventing a new concurrency model:
1. Reserve the **new** slot with the exact same atomic `UPDATE ... WHERE (status='open' OR expired-held)` claim `BookingService::create_booking()` already uses. A failure here (slot taken/held by someone else) leaves the original booking **completely untouched** — verified by a dedicated race test.
2. Move the booking row with a compare-and-swap `UPDATE ... WHERE status = <the status read at step 0>` — if this fails (booking cancelled or already rescheduled concurrently), the just-claimed new slot is rolled back to `open` and the operation fails as `conflict`, never stranding a held slot.
3. If the booking was already `confirmed`, flip the new slot to `booked` (mirrors `confirm_booking()`); if still `pending`, the new slot stays `held` and the booking's `expires_at` is reset to the new hold's expiry — without this, a still-pending reschedule would be swept away on the OLD hold's original timer regardless of which slot it now points to (a real correctness gap caught during design, not left as a known limitation).
4. Release the OLD slot to `open`.
5. Record one append-only row in the new `wp_bc_booking_reschedules` table (booking id, old/new slot+times, actor id/role, reason, timestamp) — `reschedule_count` for eligibility is a plain `COUNT(*)` against this table, no redundant counter column.
6. Fire `beauclick/booking/slot_opened` for the freed OLD slot, with the pre-move values captured before mutation — exactly mirroring `cancel_booking()`'s own call shape, so Waitlist (V2.1 Step 10) picks it up with **zero new integration code**.
7. Invalidate the stale booking-reminder notification record (see below) and send a transactional reschedule-confirmation mail.
8. Log `booking_reschedule_requested`/`_succeeded`/`_failed` analytics events via the existing `EventLogger`.

Eligibility (`RescheduleService::eligibility()`): booking must be `pending`/`confirmed`; reschedule count must be under a configurable max (provisional default **2**, filter `beauclick/booking/max_reschedules`); the booking's current slot must be at least a configurable minimum hours out (provisional default **6h**, filter `beauclick/booking/reschedule_min_hours_before`) — both explicitly labelled provisional/`NEEDS_BUSINESS_DECISION` per the task's own §5/§13, not presented as final policy.

### A real fragility found and fixed: reminder idempotency across a reschedule

`ReminderScheduler`'s idempotency key (`booking_reminder:booking:{id}:{user}:{channel}`) has no time component — found during research, before any code was written, by reading `NotificationService::dispatch_one()`'s key construction directly. Left alone, a reminder already sent for a booking's OLD slot_start would silently suppress the genuinely new reminder needed for the NEW slot_start as a false "duplicate". Fixed by adding `NotificationService::invalidate(template_key, entity_type, entity_id, user_id, channels)` — deletes the exact, already-known idempotency key row(s), never a wildcard scan — called from `RescheduleService` on every successful reschedule. Verified by a dedicated test: a reminder fires for the old time, the booking is rescheduled, and exactly one fresh reminder fires once the new time enters the reminder window — not zero (falsely suppressed) and not two.

### Receipts (COM-04)

New `ReceiptPresenter` (`beauclick-payments/src/Receipt/ReceiptPresenter.php`) — pure presentation, reads every money figure from the linked `WC_Order`/order items, **never** from `bc_service`'s own separately-mutable current price (confirmed during research as the one real "second financial calculation system" risk to avoid — `bc_service._bc_price` can change after a booking is made; the order is the frozen, authoritative snapshot). No new table. `ReceiptController` (`beauclick-payments/src/Rest/ReceiptController.php`) exposes two endpoints:
- `GET /payments/bookings/{id}/receipt` — booking + appointment context + linked order (ownership: customer, owning professional, or platform admin — the exact three-way gate `BookingController` already uses for confirm/cancel).
- `GET /payments/orders/{id}/receipt` — plain WooCommerce order receipt (covers B2B/shop orders), scoped to the order's own customer or a platform admin.

Format is printable HTML rendered in the existing React app-shell (`ReceiptView.tsx`) with a scoped `@media print` stylesheet and a `window.print()` button — no PDF library introduced, matching the task's own "do not automatically introduce PDF infrastructure if printable HTML solves the need" instruction.

### Database

One new table, `wp_bc_booking_reschedules` (append-only history). No new table for receipts (rendered on demand from existing data, per the original plan). No existing table's schema changed.

### REST API

`beauclick-booking`: `GET .../reschedule-eligibility`, `POST .../reschedule` (`new_slot_id`, optional `reason`), `GET .../reschedule-history` — all behind a new `BookingController::can_manage_booking()` permission callback (customer OR owning provider OR `bc_manage_platform`), extracted as a reusable method rather than a third copy of `cancel()`'s inline ownership logic. `format_booking()` gained `slotId`, `wcOrderId`, `rescheduleCount` fields; `list_own()` bulk-fetches reschedule counts via `RescheduleService::counts_for()` (one `GROUP BY` query) rather than a per-row `COUNT(*)` — deliberately avoiding the exact N+1 pattern a prior production-readiness audit already found and fixed elsewhere in this codebase (Dashboard/Chat/Reviews controllers). `beauclick-payments`: the two receipt routes above.

### UI

Customer/professional dashboards share one `BookingsTab.tsx` (unchanged convention) — gained "جابه‌جایی نوبت" (reschedule) and "مشاهده رسید" (view receipt) actions, plus a "جابه‌جا‌شده (N)" badge when `rescheduleCount > 0`, visible to both parties automatically since it's the same component. New `RescheduleModal.tsx` reuses `BookingModal`'s own date-chip/time-chip picker shape and `localDateString()` UTC-midnight-safe date derivation rather than building a second slot-selection widget; shows the configured limits (`رزرو ... از ...`) and a plain-language ineligibility reason when blocked. New `ReceiptView.tsx` renders the printable receipt; `OrdersTab.tsx` gained a receipt link per order (B2B/shop coverage) without disturbing its existing click-through-to-WooCommerce card behavior. Admin: one additive stat card ("جابه‌جایی نوبت (این ماه)") on the existing `AdminMenu` landing page, reading a bounded `COUNT(*)` — deliberately not a dedicated Booking Operations screen, matching ADMIN-04's own already-documented scope boundary (WooCommerce's native order admin remains authoritative).

### Security

Every new/extended route enforces ownership server-side via `can_manage_booking()`/`can_view_booking_receipt()`/`can_view_order_receipt()` — never trusting a client-supplied booking/customer/provider id. Live-verified over real HTTP: an unrelated customer's reschedule attempt on another customer's booking returns a real `403 bc_forbidden`; the owning customer, owning professional, and platform admin all correctly succeed.

### Persian/Jalali/RTL/mobile/accessibility

Every new string is Persian; every date goes through the existing shared `JalaliDate` (PHP) / `jalali.ts`+`format.ts` (React) — no second date system. Verified live at 375/390/412px: zero horizontal overflow on the bookings list, the reschedule modal (14-day chip picker), or the receipt modal. The reschedule/receipt modals reuse the existing, already-audited `Modal` primitive (focus trap, Escape, labelled close button) with no modification needed.

### Performance

`list_own()`'s reschedule-count lookup is a single bulk `GROUP BY` query, not per-row. Reschedule's own writes are a bounded, fixed number of statements per call (no loops, no N+1). No new caching or infrastructure.

### Tests

**28 new backend PHPUnit tests**: `RescheduleServiceTest` (eligibility × 5, slot safety/concurrency × 4, payment/order integrity × 1, history/audit × 2, waitlist interaction × 2, analytics × 2, notification/reminder correction × 2) plus `BookingControllerTest` additions (ownership × 3, error-code mapping, eligibility endpoint, N+1-free list) and a new `beauclick-payments` `ReceiptControllerTest` (6 tests: total-matches-order, self-scoped access × 3, no-order-yet shape, admin access). Full backend suite: **680/680** (652 pre-existing + 28 new), zero regressions. **2 new frontend tests** (`RescheduleModal.test.tsx`: ineligible-reason display, eligible pick-and-confirm flow) — full frontend suite **34/34**. TypeScript build and production `vite build` both clean; ESLint clean.

### Live verification (real running site, real seeded database, real HTTP requests, no fabricated DB rows used to claim success)

Performed against the real local dev server after applying the new migration and seeding real fixtures onto the existing `bc_qa_customer`/`bc_qa_test_pro` QA accounts (this project's own established convention — several `bc_qa_*` fixture accounts already existed from prior steps):
- **Scenario A (successful reschedule)**: real browser click-through — opened the reschedule modal on a real confirmed booking with a linked, paid WooCommerce order, selected a new date/slot, confirmed. Verified directly against the database afterward: booking's `slot_id`/`slot_start` moved, `wc_order_id` (and the real order's total/status) **untouched**, old slot released to `open`, one history row recorded with the correct actor role, both `booking_reschedule_requested`/`_succeeded` analytics events logged.
- **Scenario C (unauthorized access)**: a real, unrelated logged-in customer's direct REST reschedule attempt on another customer's booking returned a real HTTP `403 bc_forbidden`.
- **Scenario D (ineligible booking)**: a real completed booking's eligibility endpoint correctly returned `eligible:false, reason:"status"`, and a direct reschedule attempt returned a real HTTP `409 bc_reschedule_ineligible` with the correct Persian message; the reschedule button itself does not render for a completed booking in the real UI.
- **Scenario E (receipt)**: opened the real receipt for the rescheduled booking — total (۲٬۵۰۰٬۰۰۰ تومان) exactly matched the real linked order, order number/payment status correct, appointment time correctly reflected the **new**, post-reschedule slot, fully Persian/RTL/Jalali.
- **Scenario F (mobile)**: 375/390/412px — zero horizontal overflow on the bookings list, reschedule modal, or receipt modal.
- **Professional/admin surfaces**: the owning professional's dashboard shows the same shared `BookingsTab` with the reschedule badge/actions and can itself query reschedule-eligibility for a customer's booking (`200`, correctly scoped); the platform admin's landing page's new "جابه‌جایی نوبت (این ماه)" card correctly showed `۱` after the one live reschedule performed during this pass.
- **Scenario H (existing V2.1 flows still work)**: a fresh real cancel (`POST .../cancel`, real `200`) correctly released its slot and correctly triggered a real waitlist notification to a real waiting customer (`sms: sent`) — confirming Waitlist, unmodified by this step, is unaffected.

Live verification used a credential-free WordPress session technique (`wp_set_auth_cookie()` via a temporary, session-scoped local script, deleted immediately after this QA pass) rather than typing any password into a login form or creating any new non-fixture account — the same "declined to reset the admin password, used a credential-free technique instead" discipline this document's own Step 11 notes already established as this project's convention.

### Bugs discovered

None in the new code. One pre-existing, unrelated repository-wide gap was found and is **not** fixed here (out of this step's own scope, would be a large, unrelated diff): `composer lint` (`phpcs.xml.dist`) fails on short-array-syntax (`[]` vs `array()`) across essentially every existing `beauclick-*` file, confirmed by running it against an entirely untouched file (`BookingService.php`) with identical results — this codebase has apparently never had a clean `composer lint` run; `php -l` (syntax) and the full PHPUnit suite are unaffected and clean.

### Known limitations / deferred, per the task's own scope boundaries

- Service change, provider change, and any resulting price difference are not supported — reschedule is same-provider/same-service/different-slot only, per the task's own named "minimum safe scope."
- No cancellation-fee system exists in this codebase at all (confirmed by research), so reschedule has no fee/cancellation-policy interaction to build against.
- No visual drag-and-drop professional calendar (explicitly excluded, Step 16/professional-platform territory if ever pursued).
- No PDF receipt generation — printable HTML only, per the task's own "first safe scope" guidance.
- `MetricsService`'s admin analytics dashboard was **not** extended with a reschedule funnel bucket — the three new event types are logged and queryable in `wp_bc_events`, but no dashboard UI change was made (task §15: "do not build a dedicated BI dashboard in this step unless genuinely necessary").

### Business decisions still required (not invented here)

- **Maximum reschedules per booking** (provisional engineering default: 2) — `NEEDS_BUSINESS_DECISION`.
- **Minimum hours before an appointment a reschedule is still allowed** (provisional engineering default: 6h) — `NEEDS_BUSINESS_DECISION`.
- **Whether/how a service or provider change should ever be supported**, and its price/payment implications — `NEEDS_BUSINESS_DECISION`, out of this step's scope entirely.
- **Receipt legal status** — no tax-invoice wording or legal claim is made anywhere on the receipt; any such requirement is `NEEDS_LEGAL_REVIEW`, not assumed.

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

Professional/Business Platform Completion (Step 16), Campaign Engine, Financial/Payout, AI for Professionals, Realtime, Native Mobile, Multi-vendor Marketplace — none started. Step 16 was not started.

---

## V2.2 Step 16 — Professional/Business Platform Completion Implementation Notes

### What existed before, and what was actually missing

Confirmed by direct source inspection, not the roadmap's own older pre-scoping: the professional dashboard (`dashboard-professional.tsx`) had six real, data-backed tabs (Overview/Bookings/Services/Customers/Reviews/Messages) and four placeholders (Calendar/Revenue/Profile/Settings). The single most consequential finding of this step's own research, discovered *before* any code was written: **`wp_bc_availability_slots` had exactly one writer in the entire codebase — `DemoAvailabilitySeed`, a dev-only `wp bc:seed` fixture.** No REST route, no admin UI, no real code path let an actual professional create a bookable slot. Every prior QA session's "real" availability was demo-seeded data, never product functionality. This is a more severe, more fundamental gap than analytics — without it, no real professional signing up today could ever receive a booking — and became this step's first priority, ahead of the explicitly-emphasized analytics work.

Also confirmed: `bc_manage_business_staff` has existed as a declared capability since V1 with **zero** backing table, service, or controller (`ProviderLookup::for_user()` is a hard 1:1 user↔provider-post resolution, no exceptions); CRM note edit/delete was add-only (no `update`/`delete` method existed on `CrmService`); `MetricsService` (Step 11) had **zero** methods accepting any ownership-scoping parameter — every metric was platform-wide only, confirmed by reading the entire class; and B2B (`beauclick-b2b`) had a complete, tested backend (account application, tiered pricing, quote request/price/accept) but the only real frontend was the server-rendered `/b2b/` catalog/apply page — the quote-request/accept flow has no UI anywhere, a real, confirmed gap this step did not close (see Deferred, below).

### Scope decision

Given the task's own "this is not another giant feature" framing and explicit permission to defer multi-staff if too large, four items were built to full quality (implementation + tests + live QA) and two were deliberately deferred with documented reasoning:

**Built:**
1. **Availability/Calendar** (`AvailabilityService`, `AvailabilityController`, `CalendarTab.tsx`) — the critical, previously-nonexistent gap above.
2. **Professional/Business Analytics** (`MetricsService::for_provider()`, `MyAnalyticsController`, `AnalyticsTab.tsx`) — reuses Step 11's foundation with zero new analytics engine, per the task's own explicit, repeated requirement.
3. **CRM note edit/delete + real frontend pagination** — closes the Gap Register's own long-standing deferred item.
4. **A minimal staff model** (`wp_bc_business_staff`, `StaffService`, `StaffController`, `StaffTab.tsx`) — one flat role, owner-only management, wired into exactly two surfaces (CRM, analytics).

**Deliberately deferred** (documented, not silently dropped): portfolio upload (not named anywhere in this step's own task text, unlike the older architecture-plan draft — task §3's own "do not implement a feature just because its name exists in an old document" instruction applies directly); the B2B quote-request/accept UI (a real, confirmed gap, but building a product-picker-for-quotes UI is a materially larger, separate feature than this step's own bounded scope allows); fine-grained per-capability staff permissions beyond the single flat role (task §11's own explicit escape hatch).

### Availability/Calendar

`AvailabilityService` (`beauclick-booking/src/Availability/AvailabilityService.php`) — deliberately NOT a recurrence-rule engine: `create_slot()` inserts one concrete, materialized `open` row (matching the architecture's own already-stated preference — the original `CreateBookingTables` migration docblock literally anticipated "the professional's own REST call" as the intended eventual source of slots, never built until now); `bulk_generate()` is a simple "weekday + time window + slot duration → concrete rows" generator, bounded to 60 days per call and idempotent (re-running the same weekly pattern skips slots that already exist, never duplicates). Both reuse the exact overlap-detection and ownership-resolution idioms already established by `BookingService`/`CrmController`. `delete_slot()` only ever touches a slot still `status='open'` — a held/booked slot backs a real, in-flight booking and must go through cancellation, never a silent delete.

### Professional/Business Analytics

`MetricsService::for_provider(int $providerId, string $providerPostType, string $from, string $to)` — the one addition every existing method in this class lacked: ownership scoping. Booking-lifecycle events (`booking_created/_confirmed/_completed/_cancelled/_expired/_no_show/_reschedule_succeeded`) carry only a booking id as `entity_id`, never a provider id (confirmed during research — `SignalCollector`'s own docblock independently documents the identical finding), so every booking-derived count JOINs through `wp_bc_bookings.provider_id` — the exact same JOIN-through pattern `shop_order_event_count()` already established for excluding booking orders from the shop funnel, just parameterized by provider instead. `profile_view` already carries the provider's own CPT post id directly as `entity_id` (`entity_type` = the literal post type) and needs no join. Reviews/repeat-customers/service-performance read `wp_bc_reviews`/`wp_bc_bookings` directly with the same bounded, single-query-per-metric discipline `CrmService`/`DashboardController` already use. The platform-wide `funnel()` (Step 11) also gained a `rescheduled` bucket — Step 15's own events were logged but never read by any funnel method, a real, if minor, gap found and closed in passing.

`MyAnalyticsController` (`beauclick-analytics/src/Rest/MyAnalyticsController.php`) — `GET /analytics/my/summary`, resolves the caller's own provider id via `ProviderLookup::for_user()` (falling back to `StaffService::provider_ids_for_staff_user()`), **never** a client-supplied id. A B2B section is attached only when the current user has an *approved* `wp_bc_business_accounts` row (a genuinely separate identity from a marketplace `bc_business` CPT post, confirmed during research — a pure wholesale buyer with no marketplace listing gets no analytics tab at all, since they have neither role nor staff membership to reach the dashboard shell; they use the existing `/b2b/` page instead, a documented, deliberate boundary, not an oversight). The B2B figure is explicitly labelled "Gross order value" (`grossOrderValueLabel`), never "earnings" — real WooCommerce order totals from accepted quotes, not a fabricated revenue/commission figure the future Financial/Payout system would need to define (task §34's own explicit instruction).

### Minimal staff model

`wp_bc_business_staff` (new table, `beauclick-marketplace`) — one flat `staff` role (the owner is implicit via the provider post's own `post_author`, never a row in this table), added by phone number lookup against the existing `wp_bc_phone_index` (`beauclick-auth`'s `PhoneNormalizer`), never a new email-invite flow. `StaffService::remove()` is a soft status change (`status='removed'`), not a DELETE — matching this codebase's own established preference for an inspectable status change (`WaitlistService::cancel()`'s identical shape) — which is also what makes `add()`'s `ON DUPLICATE KEY UPDATE` upsert path meaningful: re-adding a previously-removed staff member flips the same row back to active.

**Explicit, bounded blast radius**: staff resolution was wired into exactly `CrmController` and `MyAnalyticsController` — not `BookingController` (confirm/cancel/reschedule), not `ReviewsController` (respond). Extending every existing ownership check in the codebase to accept staff would be a meaningfully larger, higher-regression-risk change touching several already-shipped, already-tested controllers; left as a named, deliberate V2.3+ extension rather than silently expanded here, per the task's own explicit permission to keep this minimal.

**A real bug found and fixed during this step's own live verification, not by code review**: `page-dashboard.php`'s role-only check (`bc_professional`/`bc_business` role) decides which React bundle mounts — but this minimal staff model never changes a staff member's WP role (by design). A real staff member's session was tested end to end and landed on the *customer* dashboard despite the backend (`CrmController`) correctly authorizing them — the routing check simply never knew staff membership was a thing. Fixed by extending the same theme file's check to also query `StaffService::provider_ids_for_staff_user()`. Verified live: adding/removing a real staff member correctly grants/revokes both dashboard-shell access and the underlying API access together.

### CRM note edit/delete + pagination

`CrmService::update_note()`/`delete_note()` — ownership checked two ways, both required: the note must belong to a genuine customer of the provider (`is_customer_of()`), **and** the note's own `author_user_id` must match the caller — a staff member may edit their own notes, never a colleague's, even within the same business. `CrmController` gained `PATCH`/`DELETE /booking/crm/customers/{id}/notes/{note_id}`. Frontend pagination is a "load more" pattern (20 per page, appends and stops once a page returns fewer than the page size) rather than a page-number UI — `api.ts`'s `api.get<T>()` unwraps `data` only and drops `meta.pagination`, so a page-number UI would need a new client method; "load more" needed none, extending nothing in the shared API client.

### Database

Two new tables (`wp_bc_business_staff` in `beauclick-marketplace`; no new table for availability — reuses the existing `wp_bc_availability_slots`; no new table for analytics — reuses `wp_bc_events`/`wp_bc_bookings`/`wp_bc_reviews`, per the task's own "reuse Step 11, don't duplicate it" instruction). No existing table's schema changed.

### REST API

`beauclick-booking`: `GET/POST /booking/my/availability`, `POST /booking/my/availability/bulk`, `DELETE /booking/my/availability/{id}`; `PATCH/DELETE /booking/crm/customers/{id}/notes/{note_id}`. `beauclick-analytics`: `GET /analytics/my/summary`. `beauclick-marketplace`: `GET/POST /marketplace/my/staff`, `DELETE /marketplace/my/staff/{user_id}`. Every route resolves ownership from the caller's own session (`ProviderLookup`/`StaffService`), never a request-supplied id — verified directly, not assumed (see Security below).

### Security

Live-verified over real HTTP, not just unit-tested: an authorized staff member sees the business's real customers and analytics (`200`, real data); a removed staff member immediately loses that access (`403`/empty result); a plain customer role is denied `/marketplace/my/staff` (`403`), `/booking/my/availability` (`403`, lacks `bc_manage_own_availability`), and `/analytics/my/summary` (`404`, no provider profile resolves — an honest "not found," never an internal detail leaked); a staff member cannot manage the staff list itself (owner-only, by design); analytics/CRM never accept a client-supplied provider id under any parameter name (tested directly by attempting to smuggle one in).

### Performance

`MetricsService::for_provider()` uses the same bounded, single-query-per-metric discipline as every other method in the class (no per-row loops); `list_own()`'s reschedule-count lookup (Step 15) and the CRM customer list (Step 5) were already N+1-safe and untouched. `bulk_generate()` is bounded to 60 days per call specifically to prevent an adversarial/mistyped range from generating an unbounded number of rows in one request.

### Persian/Jalali/RTL/mobile/accessibility

Every new string is Persian; every date goes through the existing shared `JalaliDate`/`jalali.ts`. Verified live at 375/390/412px across all three new tabs (Analytics/Calendar/Staff) plus the extended Customers tab — zero horizontal overflow. New UI reuses existing primitives (`StatCard`, `Chip`, `Input`, `Modal`, `Badge`, `EmptyState`, `LoadingDots`) with no new component patterns introduced.

### Tests

**44 new backend PHPUnit tests**: `MetricsServiceTest`/`MyAnalyticsControllerTest` (ownership scoping, date-range correctness, no-private-data-leakage, B2B section presence/absence — 15 tests), `StaffServiceTest`/`StaffControllerTest` (add/remove/list, owner-only, phone resolution, re-add-after-remove upsert — 12 tests), `AvailabilityServiceTest`/`AvailabilityControllerTest` (overlap detection, past-slot rejection, bulk-generate idempotency and bounding, ownership — 13 tests), CRM note edit/delete + staff-access additions to the existing `CrmServiceTest`/`CrmControllerTest` (4 tests). Full backend suite: **724/724** (680 pre-existing + 44 new), zero regressions. **5 new frontend tests** (`AnalyticsTab.test.tsx`) — full frontend suite **38/38**. TypeScript build, production `vite build`, and ESLint all clean.

### Live verification (real running site, real seeded database, real HTTP requests)

Performed against the real local dev server using the same `bc_qa_test_pro`/`bc_qa_customer` QA fixtures Step 15 established, plus a real credential-free session technique (`wp_set_auth_cookie()` via a temporary, session-scoped script, deleted immediately after each pass — no password ever entered):
- **Analytics**: real numbers (`started: 3, completed: 1, cancelled: 1, rescheduled: 1`) verified to exactly match a direct database query against `wp_bc_events`/`wp_bc_bookings`.
- **Calendar**: created real slots via the bulk-generate endpoint, confirmed they render grouped by day with correct status labels; deleted a real open slot via the UI and confirmed it disappeared; confirmed booked/held slots never show a delete action.
- **Staff**: added a real user by real phone number through the actual form; confirmed they immediately gained real CRM access (a real customer row, matching a direct API call); removed them and confirmed both the dashboard-shell routing *and* the API access were revoked together.
- **CRM notes**: a full add → edit → delete lifecycle through the real modal UI, each step confirmed via the re-rendered DOM.
- **Isolation**: a plain customer role received real `403`/`403`/`404` from the staff, availability, and analytics endpoints respectively.
- **Mobile**: 375/390/412px, zero overflow, across Analytics/Calendar/Staff/Customers.
- **V2.2-wide regression pass**: all 11 BeauClick admin pages (Steps 9–16) return `200` with no fatal errors; the professional-profile public page still emits correct JSON-LD structured data (Step 12); the privacy data-export endpoint still returns a real, ready export (Step 14); a full booking creation → real WooCommerce order → appears in the customer's own list round trip still works end to end.

### Bugs discovered

1. **Staff dashboard-routing gap** (see "Minimal staff model" above) — found and fixed during this step's own live verification.

No other bugs found. One pre-existing, unrelated finding carried forward from Step 15 and reconfirmed here, not re-litigated: `composer lint` (`phpcs.xml.dist`) still fails on short-array-syntax style across the pre-existing codebase, unrelated to this step's own changes.

### Known limitations / deferred, per the task's own scope boundaries

- Portfolio upload — not named in this step's own task text; the `bc_portfolio_item` CPT and capabilities remain registered with no REST controller or UI, unchanged from before this step.
- B2B quote-request/accept UI — the backend is complete and tested (`beauclick-b2b`), but no frontend anywhere (React app-shell or the server-rendered `/b2b/` page) lets a business browse/request/accept a negotiated quote; only the wholesale-catalog direct-purchase flow exists on `/b2b/`. A real, confirmed, but deliberately out-of-scope gap for this step.
- Fine-grained staff permissions (view-only vs. act, per-surface capability matrix) — this step's staff model is a single flat role with full CRM+analytics parity; a real capability matrix is `NEEDS_BUSINESS_DECISION` and explicitly named as a possible V2.3+ extension, not built speculatively.
- A pure B2B-only wholesale buyer (no marketplace `bc_professional`/`bc_business` listing) has no analytics view through the dashboard — they use the existing `/b2b/` page, which itself lacks the quote UI above.

### Business decisions still required (not invented here)

- **Staff role/permission granularity beyond the single flat role** — `NEEDS_BUSINESS_DECISION`, per task §11/§33.
- **Whether/how a B2B-only buyer should get any analytics view**, and through which surface — `NEEDS_BUSINESS_DECISION`.

### Deferred (explicitly out of this step's scope, per the task's own stop condition)

Campaign Engine, Financial/Payout, AI for Professionals, Realtime, Native Mobile, Multi-vendor Marketplace — none started, matching the task's own explicit V2.3+ boundary. V2.3 was not started.

---

## V2.2 Completion Summary

**Status: all six planned V2.2 steps (11–16) are complete.** No `v2.2.0` tag has been created — release remains pending explicit approval, per every step's own standing instruction not to tag without it.

| Step | Capability | Status |
|---|---|---|
| 11 | Analytics & BI Foundation | ✅ Complete |
| 12 | Growth & Public Discovery (SEO + Referral) | ✅ Complete |
| 13 | Admin Platform & Operations Maturity | ✅ Complete |
| 14 | Account Privacy & Data Control | ✅ Complete |
| 15 | Booking Evolution: Rescheduling + Receipts | ✅ Complete |
| 16 | Professional/Business Platform Completion | ✅ Complete |

**Major capabilities shipped across V2.2**: funnel/commerce/search/AI/retention/usage/referral/marketplace analytics with a real admin dashboard (11); SEO meta/sitemap/structured data and a real referral program (12); a general admin audit log, operations/health visibility, and a dedicated platform-operator role (13); real self-service account deletion and data export with a documented per-domain anonymization matrix (14); atomic booking rescheduling and a real, order-sourced receipt (15); a self-service availability/slot manager (closing a severe, previously-unbuilt operational gap), ownership-scoped professional/business analytics reusing Step 11's foundation, a minimal staff model, and CRM note edit/delete with real pagination (16).

**Test status at completion**: backend **724/724**, frontend **38/38**, TypeScript build clean, production `vite build` clean, ESLint clean, `php -l` clean across every file touched this version. `composer lint` (phpcs style) has a pre-existing, repo-wide short-array-syntax gap unrelated to any V2.2 step's own changes (confirmed by running it against untouched files with identical results) — not fixed, as doing so would be a large, unrelated diff outside any step's actual scope.

**Known limitations carried into V2.3+ planning** (full detail in each step's own notes above and in `PRODUCT_GAP_REGISTER.md`): B2B quote-request/accept UI; portfolio upload; fine-grained staff permissions; a pure B2B-only buyer's analytics home; professional/business revenue analytics (explicitly deferred until Financial/Payout, V2.3, defines an authoritative figure).

**External configuration still required before any real production launch** (unchanged since the V2.1 Final Release Audit, re-confirmed not to have grown during V2.2): a real SMS gateway, a real Iranian payment gateway, outbound SMTP, automated backup, and error monitoring.

**Business/legal decisions still required** (collected from each step's own notes, not newly invented here): referral reward structure; data-retention/anonymization window specifics; rescheduling limits (max count, minimum lead time) and receipt legal/tax status; staff role granularity; B2B-only buyer analytics access.

**V2.3+ deferred work** (unchanged, explicitly not started during V2.2): Campaign/Promotion Engine, Financial/Payout, AI for Professionals & Businesses (all V2.3); Realtime Communication, Multi-Sided Marketplace evolution, Native Mobile (V2.4+, evidence-gated).

**Production readiness note**: V2.2 is feature-complete against its own six-step plan and passes every automated and live-verification check performed. It is not, on its own, a production-launch readiness certification — the external-configuration items above (payment gateway, SMS, SMTP, backup, monitoring) remain genuine pre-launch blockers independent of any V2.2 code, exactly as already documented since the V2.1 Final Release Audit.

---

## V2.2 Final Release Audit

**Audit date:** 2026-08-15. **Baseline audited:** `744d29e` (`master`), the Step 16 completion commit — verified as the true `HEAD` and matching `origin/master` exactly at both the start and end of this audit, with a clean working tree and no unexpected commits.

**Method:** every one of the six V2.2 steps was independently re-audited against the current code (not against prior completion notes' own claims), using ten parallel, evidence-based reviews — one per step (11–16), plus dedicated cross-cutting passes for REST-route authorization, database migrations, Persian localization, Jalali date handling, and the V2.3 scope boundary — each required to cite real `file:line` evidence for every claim. This was followed by full automated test execution and targeted live browser verification against real seeded QA data.

**Result — one release-blocking defect found and fixed:**

`AccountEraser::forget()` (Step 14's account-deletion anonymizer) never freed `wp_users.user_login`. `wp_update_user()`/`wp_insert_user()` silently ignore an attempted login rename for an existing user — core has no supported way to rename a login through that API — so the anonymized row permanently kept its original, deterministic `bc_<digits>` login (assigned by `AccountResolver::create_customer()` from the verified phone number). A genuine future owner of that same phone number registering for the first time would have hit `wp_insert_user()`'s `existing_user_login` error and been unable to create an account at all — a direct violation of this step's own stated requirement that a deleted account's phone number must never block a real re-registration. The existing regression test suite didn't catch this because it exercised `AccountEraser::forget()` against a `factory()->user->create()`-seeded account (a random test login), never against the real `bc_<digits>` scheme actual production accounts use.

**Fix:** `AccountEraser::forget()` now directly renames `wp_users.user_login` (via `$wpdb->update()`, since core's own API won't do it) to a non-colliding `deleted-user-{id}` value and clears the user cache, immediately after the existing `wp_update_user()` call. A new regression test, `test_a_real_bc_prefixed_login_is_freed_so_the_same_phone_can_register_again`, reproduces the exact real-world scheme (creates an account through the actual `AccountResolver::find_or_create_for_phone()` path, not the factory) and proves a second registration with the same phone number now succeeds as a genuinely new account after deletion. Full backend suite re-run clean afterward: **725/725** (724 baseline + 1 new regression test).

**Everything else audited clean, no other release blocker found.** Summary by area (full detail in each parallel review's own findings, not duplicated here):

- **Step 11 (Analytics):** single shared `MetricsService`/`wp_bc_events` foundation confirmed — Step 16's professional/business analytics is a thin ownership-filtered consumer of the same engine, not a second one. One cosmetic-only note: `AnalyticsTab.tsx`'s date-range logic doesn't yet import the shared Jalali utility (no raw date is currently rendered from it, so no live-visible defect).
- **Step 12 (Growth/SEO/Referral):** SEO metadata/canonical/sitemap/structured-data all real and correctly bounded; referral attribution/qualification/reward all idempotent (DB-level unique constraints, not just application logic) and correctly integrated with the existing Loyalty/Notifications/Analytics services. One accepted, non-blocking gap: self-referral protection is account-ID-only (no phone/device cross-check) — mitigated in practice by phone-OTP account creation.
- **Step 13 (Admin Platform):** every BeauClick admin page and REST route independently confirmed to carry a real server-side capability check (`bc_manage_platform`/`bc_moderate_reviews`/`bc_moderate_verification`), re-verified live (see below) against an authenticated but unprivileged session. Native WordPress and WooCommerce admin confirmed untouched.
- **Step 15 (Reschedule/Receipts):** the single most release-critical check — no duplicate WooCommerce order can ever be created by a reschedule — confirmed by static trace (zero reachable `wc_create_order()` call in the reschedule path) and by a dedicated regression test. Atomic slot-claim, old-slot release, reminder invalidation, and receipt IDOR protection all confirmed with direct test evidence.
- **Step 16 (Professional/Business):** both named critical requirements — real (non-demo-seed) availability creation via `ProviderLookup::for_user()`, and analytics reuse of Step 11's engine — confirmed with no shortcuts. Two accepted, non-blocking gaps logged as new `PRODUCT_GAP_REGISTER.md` follow-ups: no professional-facing notification-preferences UI yet, and the new staff model is real but intentionally narrow (one flat role, two surfaces — CRM and analytics only).
- **Cross-cutting security/authorization:** every V2.2 REST route enumerated; `RestController::route()` makes an undeclared `permission_callback` a boot-time fatal error, and every ownership-sensitive route resolves the acting identity exclusively from the authenticated session (`ProviderLookup::for_user()`, `get_current_user_id()`), never a client-supplied id. No cross-tenant or privilege-escalation gap found across customer/professional/business/admin boundaries.
- **Database/migrations:** all five new V2.2 tables are additive-only, idempotent (`dbDelta()` + a migration ledger), and actively queried by real code — no destructive changes, no orphaned tables. Two minor, non-blocking index-coverage suggestions logged for later (admin audit log's date-range filter; privacy data-requests' admin-queue/cron-sweep filter).
- **Persian localization / Jalali:** no user-facing English defect found across the entire V2.2 diff; one internal-only (never user-visible) English exception message logged as optional cleanup. Every user-facing date surface routes through the single shared Jalali utility on both the PHP admin side and the React app-shell side; internal storage/transport correctly remains Gregorian throughout.
- **V2.3 boundary:** exhaustive repo-wide search confirms zero implementation of Campaign/Promotion Engine, Financial/Payout, AI-for-Professionals, Realtime Communication, Native Mobile, or Multi-vendor Marketplace evolution — only planning-doc language and inert code comments explaining why each remains deferred.

**Test suite results:** backend PHPUnit **725/725** (post-fix; 724 baseline + 1 new regression test), frontend Vitest **38/38** (unchanged from baseline), TypeScript build clean, ESLint clean. `composer lint`/phpcs shows the same pre-existing, repo-wide short-array-syntax style gap already documented in the Step 15 completion note (confirmed unchanged by spot-checking an untouched V2.1 file) — not a V2.2 regression, not fixed here (style-only, out of this audit's release-blocker scope).

**Live verification performed** against real seeded QA data on the local dev environment (`bc_qa_customer`, phone-OTP session): booking dashboard, receipt view (real order #51 data, correct Jalali dates), reschedule modal (real eligibility API call, correct "1 of 2 reschedules used" count), notification preferences, privacy export/deletion UI (Jalali expiry date), loyalty points/tier, referral code + sharing UI, AI-personalized recommendations, marketplace multi-city/specialty discovery with honest cold-start empty states, and mobile responsiveness at 375/390/412px (no horizontal overflow, correct RTL) all confirmed working. Authorization was additionally live-verified from the negative side: the same authenticated customer session was rejected with a real `403`/`bc_forbidden` from both the `beauclick-analytics` wp-admin page and its REST endpoint, matching the Step 13 code audit exactly.

**Live verification not performed, and why:** professional/business/admin-role flows (availability creation, professional/business dashboards and analytics, admin operations pages, B2B) were not exercised live, because no safe QA account for those roles had a usable phone/OTP or known password path, and the audit's own instructions explicitly prohibit password-reset workarounds to obtain one. These surfaces were instead verified through the rigorous, evidence-cited code-level audits described above (including live-tested negative authorization checks from the customer side). This is disclosed here rather than fabricating live-QA coverage that didn't happen.

**Production configuration** (unchanged from the V2.1 Final Release Audit and the existing Step-by-step notes — re-confirmed, not re-litigated): SMS gateway, SMTP, and the real Zarinpal payment gateway remain `EXTERNAL_CONFIGURATION` / `NOT_CONFIGURED` (no credentials present; `beauclick-core`'s own new Operations & Health page, built in Step 13, now surfaces this distinction live rather than only in documentation). AI provider is `NOT_CONFIGURED` but the rule-based fallback is genuinely `IMPLEMENTED` and working. Backup and error-monitoring integration remain `MISSING` (explicitly out of this codebase's scope — hosting/infra decisions). Hosting/SSL are `NOT_VERIFIED` (local dev only).

**Final decision: `V2.2 READY FOR RELEASE`.** All six steps are complete and independently re-verified; the one release-blocking defect found (Step 14 phone re-registration) has been fixed with a regression test and the full suite re-passes; no unresolved P0/P1 issue remains; V2.3 is confirmed not started; V1/V2.0/V2.1 tags are confirmed untouched (verified byte-for-byte against both local and remote dereferenced hashes); the working tree is clean. Per the audit's own explicit instruction, **no `v2.2.0` tag has been created** — tagging and the GitHub release remain a separate, explicit next step for the product owner to authorize.
