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
